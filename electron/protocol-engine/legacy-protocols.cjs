"use strict";
/**
 * DX OS legacy 协议表（PROTOCOLS / PROVIDER_PROTOCOLS）与纯函数移植。
 * 源：DXSRC/protocols.ts
 *   · :78-279      常量（ASPECT_OPTIONS / *_SCHEMA / *_LIMITS / *_PROFILE）
 *   · :281-2568    PROTOCOLS（29 个模型协议）
 *   · :2589-2982   PROVIDER_PROTOCOLS（20 个供应商协议；本仓另加官方协议 lovart，共 21）
 *   · :3183-3636   别名/站点规则/列表/规范化/请求构造/响应解析纯函数
 *
 * 只保留本地可用语义；以下分支已移除并在调用处标注：
 *   1) 网络执行函数（callChat/streamChat/chatWithTools/generateImages/... 源 :3638+）由 W4 负责。
 *   2) 云计费 apiQuota（assertApiModelAccess/withDirectApiQuota，源 :19）属 OUT，未移植。
 *   3) 远程协议包分支 remoteProtocolStore.bindings / remoteProviderIds / remoteModelIds
 *      （源 :3250-3256、:3327、:3375、:3385）：DX OS 从 api.dx-os.com 拉取协议包
 *      （protocolUpdates.ts），本地化不联网，故只保留内置规则。
 *   4) dx-protocol/v2 查询 getProtocolV2（源 :3391/:3400/:3597）已按源接回：在函数内惰性
 *      require('./repository.cjs')，避免与 v2 仓库的模块初始化顺序耦合。
 *   5) 运行时外部依赖（runninghub/modelscope/agnes/cliTools/agentCliTools/sharp/dataPath）不在本文件加载：
 *      executor.adapter 仅作为数据原样保留；这些依赖已由 B7e2/B7e3/B3 落地为端口/适配器
 *      （plugin-runninghub.cjs / plugin-modelscope.cjs / plugin-agnes.cjs / legacy-cli-ports.cjs /
 *      agent-cli-tools.cjs / agent-cli-bridge.cjs），由执行器按注入端口调用，未注入即结构化拒绝。
 *   6) 自定义协议 customProtocolStore 已移植到 legacy-custom-protocol-store.cjs（源 :2984-3181）：
 *      旧版扁平仓库 <userData>/dxos/custom-protocols.json 在列表/详情读取时惰性装载进本文件的
 *      PROTOCOLS / PROVIDER_PROTOCOLS，详情列表按 store 如实标注 origin（builtin / custom）。
 *      这是与 dx-protocol/v2（repository.cjs）不同的一套机制，边界见该文件头说明。
 *   7) joinUrl/buildChatRequest 依赖的两个纯 URL 规范化函数
 *      normalizeAgTokenApiBaseUrl（源 agtokenEndpoint.ts:2-9）与
 *      normalizeAgnesApiBaseUrl（源 agnesEndpoint.ts:5-14）因本地无 .cjs，内联移植于本文件。
 */
const { OPENAI_MINIMAX_VIDEO_PROFILES } = require("./openAiMinimaxProfiles.cjs");
// 旧版自定义协议仓库（源 protocols.ts:2984-3181）。顶层 require 只依赖 foundation paths，
// 对 legacy-protocols 的引用在 store 内部惰性解析，故不会形成模块初始化循环。
const customProtocolStore = require("./legacy-custom-protocol-store.cjs");
const ASPECT_OPTIONS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9']
const APIMART_VIDEO_ASPECT_OPTIONS = [...ASPECT_OPTIONS, 'adaptive']
const VIDEO_SCHEMA = [
  { key: 'duration', label: '视频时长', description: '输出视频的目标时长（秒），实际范围由模型协议校验。', type: 'number', default: 5, min: 1, max: 60, step: 1, bind: 'body.duration' },
  { key: 'aspect_ratio', label: '画面比例', description: '输出画面的宽高比。', type: 'select', default: '16:9', options: ASPECT_OPTIONS.map((value) => ({ label: value, value })), bind: 'body.aspect_ratio' },
  { key: 'resolution', label: '输出清晰度', description: '输出分辨率档位，模型不支持时由协议适配器给出明确提示。', type: 'select', default: '720p', options: ['480p', '720p', '1080p', '4k'].map((value) => ({ label: value.toUpperCase(), value })), bind: 'body.resolution' },
  { key: 'generate_audio', label: '同时生成声音', description: '让支持音视频联合生成的模型同时生成环境声、对白或音乐。', type: 'toggle', default: false, bind: 'body.generate_audio' },
  { key: 'enhance_prompt', label: '自动优化提示词', description: '由平台扩写和优化视频提示词。', type: 'toggle', default: false, bind: 'body.enhance_prompt' },
  { key: 'camera_fixed', label: '固定镜头', description: '减少镜头位移，适合固定机位或产品展示。', type: 'toggle', default: false, bind: 'body.camerafixed' },
  { key: 'watermark', label: '添加水印', type: 'toggle', default: false, bind: 'body.watermark' },
  { key: 'seed', label: '随机种子', description: '相同模型和参数下用于提高结果可复现性；0 表示随机。', type: 'number', default: 0, min: 0, bind: 'body.seed' },
]
const PIPPIT_VIDEO_SCHEMA = [
  { key: 'duration', label: '视频时长', description: '小云雀视频生成时长（秒）。', type: 'number', default: 5, min: 1, max: 30, step: 1, bind: 'video_part_tool_param.duration_sec' },
  { key: 'aspect_ratio', label: '画面比例', description: '传给小云雀视频模型的画面宽高比。', type: 'select', default: '16:9', options: ASPECT_OPTIONS.map((value) => ({ label: value, value })), bind: 'video_part_tool_param.ratio' },
  { key: 'resolution', label: '输出清晰度', description: '小云雀官方 CLI 当前公开的常用视频分辨率。', type: 'select', default: '720p', options: ['720p', '1080p'].map((value) => ({ label: value.toUpperCase(), value })), bind: 'video_part_tool_param.resolution' },
]
const PIPPIT_VIDEO_UPSCALE_SCHEMA = [
  { key: 'output_resolution', label: '目标清晰度', type: 'select', default: '1080p', options: ['720p', '1080p', '2k', '4k'].map((value) => ({ label: value.toUpperCase(), value })), bind: 'video_part_tool_param.mini_tool_param.tool_param.video_super_resolution_tool_param.output_resolution' },
  { key: 'tool_version', label: '处理版本', type: 'select', default: 'standard', options: [{ label: '标准', value: 'standard' }, { label: '专业 V1', value: 'professional_v1' }, { label: '专业 V2', value: 'professional_v2' }], bind: 'video_part_tool_param.mini_tool_param.tool_param.video_super_resolution_tool_param.tool_version' },
]
const JIMENG_VIDEO_RATIOS = ['1:1', '3:4', '16:9', '4:3', '9:16', '21:9']
const GEMINI_IMAGE_DERIVE = {
  aspectRatio: {
    op: 'coalesce',
    values: [{ ref: 'params.aspect_ratio' }, { ref: 'params.aspectRatio' }, { literal: '1:1' }],
  },
  imageSize: {
    op: 'lookup',
    value: {
      op: 'coalesce',
      values: [{ ref: 'params.resolution' }, { ref: 'params.imageSize' }, { literal: '1k' }],
    },
    cases: { '1k': '1K', '2k': '2K', '4k': '4K', '1K': '1K', '2K': '2K', '4K': '4K' },
    fallback: '1K',
  },
}
const JIMENG_IMAGE_FEATURES = {
  postprocess: {
    imageUpscale: {
      operation: 'image.upscale',
      resolutions: ['2k', '4k', '8k'],
      defaultResolution: '2k',
    },
  },
  resolutionDisplay: {
    '1k': {
      label: '1.5K',
      detail: '即梦标准输出',
      pixelsByAspect: {
        '1:1': [1536, 1536],
        '2:3': [1024, 1536],
        '3:2': [1536, 1024],
        '3:4': [1152, 1536],
        '4:3': [1536, 1152],
        '9:16': [864, 1536],
        '16:9': [1536, 864],
        '21:9': [1536, 658],
        '9:21': [658, 1536],
      },
    },
  },
}
const JIMENG_BASE_VIDEO_LIMITS = {
  duration: { min: 4, max: 15, step: 1, integer: true, default: 5 },
  aspect_ratio: { options: JIMENG_VIDEO_RATIOS, default: '16:9' },
  resolution: { options: ['720p'], default: '720p' },
  references: { images: { max: 9 }, videos: { max: 3 }, audios: { max: 3 } },
  features: { generate_audio: false, enhance_prompt: false, camera_fixed: false, watermark: false },
}
const JIMENG_SEEDANCE2_LIMITS = {
  ...JIMENG_BASE_VIDEO_LIMITS,
  byCapability: {
    'video.text_to_video': { references: { images: { max: 0 }, videos: { max: 0 }, audios: { max: 0 } } },
    'video.image_to_video': { references: { images: { min: 1, max: 1 }, videos: { max: 0 }, audios: { max: 0 } } },
    'video.first_last_frame': { references: { images: { min: 2, max: 2 }, videos: { max: 0 }, audios: { max: 0 } }, features: { outputAspectRatio: 'input' } },
    'video.multi_reference': { references: { images: { min: 2, max: 20 }, videos: { max: 0 }, audios: { max: 0 } } },
    'video.video_to_video': { references: { images: { max: 9 }, videos: { min: 1, max: 3 }, audios: { max: 3 } } },
    'video.audio_reference': { references: { images: { min: 1, max: 9 }, videos: { max: 0 }, audios: { min: 1, max: 3 } } },
  },
}
const JIMENG_SEEDANCE25_LIMITS = {
  ...JIMENG_BASE_VIDEO_LIMITS,
  duration: { min: 4, max: 30, step: 1, integer: true, default: 5 },
  resolution: { options: ['480p', '720p', '1080p'], default: '720p' },
  references: { images: { max: 30 }, videos: { max: 10 }, audios: { max: 10 } },
  byCapability: {
    'video.text_to_video': { references: { images: { max: 0 }, videos: { max: 0 }, audios: { max: 0 } } },
    'video.image_to_video': { references: { images: { min: 1, max: 1 }, videos: { max: 0 }, audios: { max: 0 } } },
    'video.first_last_frame': { references: { images: { min: 2, max: 2 }, videos: { max: 0 }, audios: { max: 0 } }, features: { outputAspectRatio: 'input' } },
    'video.multi_reference': { references: { images: { min: 2, max: 30 }, videos: { max: 0 }, audios: { max: 0 } } },
    'video.video_to_video': { references: { images: { max: 30 }, videos: { min: 1, max: 10 }, audios: { max: 10 } } },
    'video.audio_reference': { references: { images: { max: 30 }, videos: { max: 10 }, audios: { min: 1, max: 10 } } },
    'video.multimodal': { references: { images: { max: 30 }, videos: { max: 10 }, audios: { max: 10 } } },
  },
}
const VOLCENGINE_SEEDANCE_LIMITS = {
  ...JIMENG_BASE_VIDEO_LIMITS,
  resolution: { options: ['480p', '720p', '1080p'], default: '720p' },
  byCapability: {
    ...JIMENG_SEEDANCE2_LIMITS.byCapability,
    'video.multimodal': { references: { images: { max: 9 }, videos: { max: 3 }, audios: { max: 3 } } },
  },
}
const MINIMAX_H3_LIMITS = {
  duration: { min: 4, max: 15, step: 1, integer: true, default: 5 },
  aspect_ratio: { options: ['adaptive', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16'], default: '16:9' },
  resolution: { options: ['768P', '2K'], default: '768P' },
  references: { images: { max: 9 }, videos: { max: 3 }, audios: { max: 3 } },
  features: { generate_audio: true, watermark: true },
  byCapability: {
    'video.text_to_video': { references: { images: { max: 0 }, videos: { max: 0 }, audios: { max: 0 } } },
    'video.image_to_video': { references: { images: { min: 1, max: 1 }, videos: { max: 0 }, audios: { max: 0 } } },
    'video.first_last_frame': { aspect_ratio: { options: ['adaptive'], default: 'adaptive' }, references: { images: { min: 2, max: 2 }, videos: { max: 0 }, audios: { max: 0 } } },
    'video.multi_reference': { references: { images: { min: 1, max: 9 }, videos: { max: 0 }, audios: { max: 0 } } },
    'video.video_to_video': { references: { images: { max: 9 }, videos: { min: 1, max: 3 }, audios: { max: 3 } } },
    'video.audio_reference': { references: { images: { max: 9 }, videos: { max: 3 }, audios: { min: 1, max: 3 } } },
    'video.multimodal': { references: { images: { max: 9 }, videos: { max: 3 }, audios: { max: 3 } } },
  },
}
const APIMART_VEO_LIMITS = {
  duration: { min: 4, max: 8, step: 1, integer: true, default: 5, options: [4, 5, 8] },
  size: { options: ['16:9', '9:16'], default: '16:9' },
  aspect_ratio: { options: ['16:9', '9:16'], default: '16:9' },
  resolution: { options: ['720p', '1080p', '4k'], default: '720p' },
  references: { images: { max: 3 }, videos: { max: 0 }, audios: { max: 0 } },
  features: { enhance_prompt: false, camera_fixed: false, watermark: false },
}
const APIMART_SEEDANCE_LIMITS = {
  duration: { min: 4, max: 15, step: 1, integer: true, default: 5 },
  size: { options: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'adaptive'], default: '16:9' },
  aspect_ratio: { options: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'adaptive'], default: '16:9' },
  resolution: { options: ['480p', '720p', '1080p', '4k'], default: '720p' },
  references: { images: { max: 9 }, videos: { max: 3 }, audios: { max: 3 } },
}
const APIMART_SEEDANCE25_PROFILE = {
  label: 'Seedance 2.5 via APIMart',
  match: ['doubao-seedance-2.5', 'doubao-seedance-2-5', 'seedance-2.5', 'seedance-2-5', 'seedance2.5'],
  capabilities: ['video.generate', 'video.text_to_video', 'video.image_to_video', 'video.first_last_frame', 'video.multi_reference', 'video.video_to_video', 'video.audio_reference', 'video.multimodal'],
  uiSchemas: ['apimart-video-generate'],
  operationPreference: ['video.generate', 'video.image_to_video'],
  limits: { ...APIMART_SEEDANCE_LIMITS, duration: { min: 4, max: 30, step: 1, integer: true, default: 5 }, resolution: { options: ['480p', '720p', '1080p'], default: '720p' }, references: { images: { max: 30 }, videos: { max: 10 }, audios: { max: 10 } } },
}
const IMAGE_SCHEMA = [
  { key: 'aspect_ratio', label: '比例', type: 'select', default: '1:1', options: ['1:1', '4:3', '3:4', '16:9', '9:16'].map((value) => ({ label: value, value })), bind: 'body.aspect_ratio' },
  { key: 'size', label: '尺寸', type: 'select', default: '1024x1024', options: ['1024x1024', '1024x1536', '1536x1024', '1792x1024', '1024x1792'].map((value) => ({ label: value, value })), bind: 'body.size' },
  { key: 'seed', label: '种子', type: 'number', default: 0, min: 0, bind: 'body.seed' },
]
const MODELSCOPE_IMAGE_SCHEMA = [
  { key: 'size', label: '尺寸', type: 'select', default: '1024x1024', options: ['1024x1024', '1024x1536', '1536x1024', '1792x1024', '1024x1792'].map((value) => ({ label: value, value })), bind: 'body.size' },
]
const VOLCENGINE_IMAGE_SCHEMA = [
  { key: 'size', label: '尺寸', description: 'Seedream 5.0 建议从 2K 起步。', type: 'select', default: '2048x2048', options: ['2048x2048', '2048x3072', '3072x2048', '4096x4096'].map((value) => ({ label: value, value })), bind: 'body.size' },
]
const VOLCENGINE_VIDEO_SCHEMA = [
  { key: 'duration', label: '视频时长', type: 'number', default: 5, min: 1, max: 60, step: 1, bind: 'body.duration' },
  { key: 'aspect_ratio', label: '画面比例', type: 'select', default: '16:9', options: ASPECT_OPTIONS.map((value) => ({ label: value, value })), bind: 'body.ratio' },
  { key: 'resolution', label: '输出清晰度', type: 'select', default: '720p', options: ['480p', '720p', '1080p'].map((value) => ({ label: value.toUpperCase(), value })), bind: 'body.resolution' },
  { key: 'generate_audio', label: '同时生成声音', type: 'toggle', default: false, bind: 'body.generate_audio' },
  { key: 'camera_fixed', label: '固定镜头', type: 'toggle', default: false, bind: 'body.camerafixed' },
  { key: 'watermark', label: '添加水印', type: 'toggle', default: false, bind: 'body.watermark' },
  { key: 'seed', label: '随机种子', type: 'number', default: 0, min: 0, bind: 'body.seed' },
]
const VOLCENGINE_SPEECH_SCHEMA = [
  { key: 'speaker', label: '音色 ID', type: 'text', default: 'zh_female_vv_uranus_bigtts', bind: 'body.req_params.speaker' },
  { key: 'response_format', label: '格式', type: 'select', default: 'mp3', options: ['mp3', 'wav', 'pcm', 'ogg_opus'].map((value) => ({ label: value.toUpperCase(), value })), bind: 'body.req_params.audio_params.format' },
  { key: 'sample_rate', label: '采样率', type: 'select', default: 24000, options: [16000, 24000, 32000, 44100, 48000].map((value) => ({ label: `${value} Hz`, value })), bind: 'body.req_params.audio_params.sample_rate' },
  { key: 'speech_rate', label: '语速', type: 'slider', default: 0, min: -50, max: 100, step: 1, bind: 'body.req_params.audio_params.speech_rate' },
  { key: 'loudness_rate', label: '音量', type: 'slider', default: 0, min: -50, max: 100, step: 1, bind: 'body.req_params.audio_params.loudness_rate' },
  { key: 'pitch_rate', label: '音调', type: 'number', default: 0, min: -12, max: 12, step: 1, bind: 'body.req_params.audio_params.pitch_rate' },
]
const AGNES_IMAGE_SCHEMA = [
  { key: 'size', label: '尺寸', type: 'select', default: '1024x1024', options: ['1024x1024', '1024x1536', '1536x1024'].map((value) => ({ label: value, value })), bind: 'body.size' },
]
const MUSIC_SCHEMA = [
  { key: 'title', label: '标题', type: 'text', default: '', bind: 'body.title' },
  { key: 'lyrics', label: '歌词', type: 'textarea', default: '', bind: 'body.lyrics' },
  { key: 'style', label: '风格', type: 'text', default: '', bind: 'body.style' },
  { key: 'instrumental', label: '纯音乐', type: 'toggle', default: false, bind: 'body.instrumental' },
]
const PROTOCOLS = {
  ollama: {
    id: 'ollama',
    label: 'Ollama',
    kind: 'provider-protocol-package',
    summary: '本机 Ollama 的 OpenAI 兼容接口，无需 API Key。',
    categories: ['llm', 'vision', 'tools', 'local'],
    auth: { type: 'none' },
    models: { endpoint: '/v1/models', kind: 'openai' },
    stream: true,
    capabilities: {
      llm: { endpoint: '/v1/chat/completions', body: 'openai_chat', parse: 'openai_chat' },
      vlm: { endpoint: '/v1/chat/completions', body: 'openai_chat', parse: 'openai_chat' },
    },
    docs: [{ title: 'Ollama OpenAI compatibility', url: 'https://docs.ollama.com/openai' }],
  },
  openai: {
    id: 'openai',
    label: 'OpenAI 兼容',
    kind: 'provider-protocol-package',
    summary: 'OpenAI 风格协议包：Chat Completions、流式返回、视觉输入、工具调用、结构化输出、Responses、Images、Video、Audio、Embeddings、Files 与 Batches。',
    categories: ['llm', 'vision', 'tools', 'responses', 'image', 'video', 'audio', 'embedding', 'files', 'batches', 'moderation'],
    auth: { type: 'bearer', header: 'Authorization', prefix: 'Bearer ' },
    models: { endpoint: '/v1/models', kind: 'openai' },
    stream: true,
    capabilities: {
      llm: { endpoint: '/v1/chat/completions', body: 'openai_chat', parse: 'openai_chat' },
      vlm: { endpoint: '/v1/chat/completions', body: 'openai_chat', parse: 'openai_chat' },
    },
    operations: {
      'llm.chat': {
        label: 'Chat Completions',
        method: 'POST',
        path: '/v1/chat/completions',
        requestMode: 'json',
        bodyTemplate: {
          model: '{{model}}',
          messages: '{{messages}}',
          temperature: '{{params.temperature}}',
          top_p: '{{params.top_p}}',
          max_tokens: '{{params.max_tokens}}',
          response_format: '{{params.response_format}}',
        },
        response: {
          text: '$.choices[0].message.content',
          finishReason: '$.choices[0].finish_reason',
          usage: '$.usage',
        },
        uiSchema: 'openai-chat',
      },
      'llm.chat.stream': {
        label: 'Chat Completions Stream',
        method: 'POST',
        path: '/v1/chat/completions',
        requestMode: 'json',
        bodyTemplate: {
          model: '{{model}}',
          messages: '{{messages}}',
          stream: true,
          temperature: '{{params.temperature}}',
          top_p: '{{params.top_p}}',
          max_tokens: '{{params.max_tokens}}',
        },
        stream: {
          protocol: 'sse',
          eventPrefix: 'data:',
          done: '[DONE]',
          deltaText: '$.choices[0].delta.content',
          deltaToolCalls: '$.choices[0].delta.tool_calls',
        },
        uiSchema: 'openai-chat-stream',
      },
      'llm.chat.vision': {
        label: 'Chat Vision',
        method: 'POST',
        path: '/v1/chat/completions',
        requestMode: 'json',
        bodyTemplate: {
          model: '{{model}}',
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: '{{prompt}}' },
                { type: 'image_url', image_url: { url: '{{inputs.imageUrl}}' } },
              ],
            },
          ],
          temperature: '{{params.temperature}}',
          max_tokens: '{{params.max_tokens}}',
        },
        response: {
          text: '$.choices[0].message.content',
          usage: '$.usage',
        },
        uiSchema: 'openai-vision',
      },
      'llm.tools': {
        label: 'Chat Tool Calling',
        method: 'POST',
        path: '/v1/chat/completions',
        requestMode: 'json',
        bodyTemplate: {
          model: '{{model}}',
          messages: '{{messages}}',
          tools: '{{tools}}',
          tool_choice: '{{params.tool_choice}}',
          stream: '{{params.stream}}',
        },
        response: {
          text: '$.choices[0].message.content',
          toolCalls: '$.choices[0].message.tool_calls',
          usage: '$.usage',
        },
        uiSchema: 'openai-tools',
      },
      'llm.structured_output': {
        label: 'Structured Output',
        method: 'POST',
        path: '/v1/chat/completions',
        requestMode: 'json',
        bodyTemplate: {
          model: '{{model}}',
          messages: '{{messages}}',
          response_format: {
            type: 'json_schema',
            json_schema: '{{params.json_schema}}',
          },
        },
        response: {
          jsonText: '$.choices[0].message.content',
          usage: '$.usage',
        },
        uiSchema: 'openai-structured-output',
      },
      'llm.responses': {
        label: 'Responses',
        method: 'POST',
        path: '/v1/responses',
        requestMode: 'json',
        bodyTemplate: {
          model: '{{model}}',
          input: '{{input}}',
          instructions: '{{params.instructions}}',
          temperature: '{{params.temperature}}',
          top_p: '{{params.top_p}}',
          max_output_tokens: '{{params.max_output_tokens}}',
          text: '{{params.text}}',
          tools: '{{tools}}',
        },
        response: {
          text: '$.output_text',
          output: '$.output',
          usage: '$.usage',
        },
        uiSchema: 'openai-responses',
      },
      'llm.responses.stream': {
        label: 'Responses Stream',
        method: 'POST',
        path: '/v1/responses',
        requestMode: 'json',
        bodyTemplate: {
          model: '{{model}}',
          input: '{{input}}',
          stream: true,
          instructions: '{{params.instructions}}',
          max_output_tokens: '{{params.max_output_tokens}}',
          tools: '{{tools}}',
        },
        stream: {
          protocol: 'sse',
          deltaTextEvents: ['response.output_text.delta'],
          doneEvents: ['response.completed'],
          errorEvents: ['response.failed', 'error'],
        },
        uiSchema: 'openai-responses-stream',
      },
      'image.generate': {
        label: 'Images Generations',
        method: 'POST',
        path: '/v1/images/generations',
        requestMode: 'json',
        bodyTemplate: {
          model: '{{model}}',
          prompt: '{{prompt}}',
          size: '{{params.size}}',
          quality: '{{params.quality}}',
          n: '{{params.n}}',
          response_format: '{{params.response_format}}',
        },
        response: {
          images: '$.data[*].url || $.data[*].b64_json',
          usage: '$.usage',
        },
        uiSchema: 'openai-image-generate',
      },
      'image.edit': {
        label: 'Images Edits',
        method: 'POST',
        path: '/v1/images/edits',
        requestMode: 'multipart',
        bodyTemplate: {
          model: '{{model}}',
          prompt: '{{prompt}}',
          image: '{{inputs.images}}',
          size: '{{params.size}}',
          quality: '{{params.quality}}',
          n: '{{params.n}}',
        },
        response: {
          images: '$.data[*].url || $.data[*].b64_json',
          usage: '$.usage',
        },
        uiSchema: 'openai-image-edit',
      },
      'video.generate': {
        label: 'Video Generations',
        method: 'POST',
        path: '/v1/videos/generations',
        fallbackPaths: ['/v2/videos/generations'],
        requestMode: 'json',
        bodyTemplate: {
          model: '{{model}}',
          prompt: '{{prompt}}',
          duration: '{{params.duration}}',
          aspect_ratio: '{{params.aspect_ratio}}',
          resolution: '{{params.resolution}}',
          size: '{{params.size}}',
        },
        response: {
          taskId: '$.id || $.task_id || $.data.id || $.data.task_id',
          videos: '$..video_url || $..url',
        },
        uiSchema: 'openai-video-generate',
      },
      'video.image_to_video': {
        label: 'Image To Video',
        method: 'POST',
        path: '/v1/videos/generations',
        fallbackPaths: ['/v2/videos/generations'],
        requestMode: 'json',
        bodyTemplate: {
          model: '{{model}}',
          prompt: '{{prompt}}',
          images: '{{inputs.images}}',
          duration: '{{params.duration}}',
          aspect_ratio: '{{params.aspect_ratio}}',
          resolution: '{{params.resolution}}',
        },
        response: {
          taskId: '$.id || $.task_id || $.data.id || $.data.task_id',
          videos: '$..video_url || $..url',
        },
        uiSchema: 'openai-video-generate',
      },
      'audio.tts': {
        label: 'Audio Speech',
        method: 'POST',
        path: '/v1/audio/speech',
        requestMode: 'json',
        bodyTemplate: {
          model: '{{model}}',
          input: '{{input}}',
          voice: '{{params.voice}}',
          response_format: '{{params.response_format}}',
          speed: '{{params.speed}}',
        },
        response: {
          audio: 'binary',
          contentType: 'audio/*',
        },
        uiSchema: 'openai-audio-speech',
      },
      'audio.transcribe': {
        label: 'Audio Transcriptions',
        method: 'POST',
        path: '/v1/audio/transcriptions',
        requestMode: 'multipart',
        bodyTemplate: {
          model: '{{model}}',
          file: '{{inputs.audio}}',
          language: '{{params.language}}',
          prompt: '{{params.prompt}}',
          response_format: '{{params.response_format}}',
          temperature: '{{params.temperature}}',
        },
        response: {
          text: '$.text',
          segments: '$.segments',
        },
        uiSchema: 'openai-audio-transcribe',
      },
      'audio.translate': {
        label: 'Audio Translations',
        method: 'POST',
        path: '/v1/audio/translations',
        requestMode: 'multipart',
        bodyTemplate: {
          model: '{{model}}',
          file: '{{inputs.audio}}',
          prompt: '{{params.prompt}}',
          response_format: '{{params.response_format}}',
          temperature: '{{params.temperature}}',
        },
        response: {
          text: '$.text',
        },
        uiSchema: 'openai-audio-transcribe',
      },
      'embeddings.create': {
        label: 'Embeddings',
        method: 'POST',
        path: '/v1/embeddings',
        requestMode: 'json',
        bodyTemplate: {
          model: '{{model}}',
          input: '{{input}}',
          encoding_format: '{{params.encoding_format}}',
          dimensions: '{{params.dimensions}}',
        },
        response: {
          embeddings: '$.data[*].embedding',
          usage: '$.usage',
        },
        uiSchema: 'openai-embeddings',
      },
      'moderation.create': {
        label: 'Moderations',
        method: 'POST',
        path: '/v1/moderations',
        requestMode: 'json',
        bodyTemplate: {
          model: '{{model}}',
          input: '{{input}}',
        },
        response: {
          results: '$.results',
        },
      },
      'files.upload': {
        label: 'Files Upload',
        method: 'POST',
        path: '/v1/files',
        requestMode: 'multipart',
        bodyTemplate: {
          file: '{{inputs.file}}',
          purpose: '{{params.purpose}}',
        },
        response: {
          id: '$.id',
          filename: '$.filename',
          purpose: '$.purpose',
        },
        uiSchema: 'openai-files',
      },
      'files.list': {
        label: 'Files List',
        method: 'GET',
        path: '/v1/files',
        requestMode: 'query',
        response: {
          files: '$.data',
        },
      },
      'files.retrieve': {
        label: 'Files Retrieve',
        method: 'GET',
        path: '/v1/files/{file_id}',
        requestMode: 'path',
        response: {
          file: '$',
        },
      },
      'files.delete': {
        label: 'Files Delete',
        method: 'DELETE',
        path: '/v1/files/{file_id}',
        requestMode: 'path',
        response: {
          deleted: '$.deleted',
        },
      },
      'batches.create': {
        label: 'Batches Create',
        method: 'POST',
        path: '/v1/batches',
        requestMode: 'json',
        bodyTemplate: {
          input_file_id: '{{params.input_file_id}}',
          endpoint: '{{params.endpoint}}',
          completion_window: '{{params.completion_window}}',
          metadata: '{{params.metadata}}',
        },
        response: {
          batch: '$',
        },
        uiSchema: 'openai-batches',
      },
      'batches.retrieve': {
        label: 'Batches Retrieve',
        method: 'GET',
        path: '/v1/batches/{batch_id}',
        requestMode: 'path',
        response: {
          batch: '$',
        },
      },
      'batches.cancel': {
        label: 'Batches Cancel',
        method: 'POST',
        path: '/v1/batches/{batch_id}/cancel',
        requestMode: 'path',
        response: {
          batch: '$',
        },
      },
    },
    modelProfiles: {
      'gpt-4o': {
        label: 'GPT-4o',
        capabilities: ['llm.chat', 'llm.chat.stream', 'llm.chat.vision', 'llm.tools', 'llm.structured_output'],
        uiSchemas: ['openai-chat', 'openai-vision', 'openai-tools'],
      },
      'gpt-4o-mini': {
        label: 'GPT-4o mini',
        capabilities: ['llm.chat', 'llm.chat.stream', 'llm.chat.vision', 'llm.tools', 'llm.structured_output'],
        uiSchemas: ['openai-chat', 'openai-vision', 'openai-tools'],
      },
      'gpt-5': {
        label: 'GPT-5 / Responses 优先',
        capabilities: ['llm.responses', 'llm.responses.stream', 'llm.tools', 'llm.structured_output'],
        uiSchemas: ['openai-responses', 'openai-tools'],
        operationPreference: ['llm.responses', 'llm.responses.stream'],
      },
      'o-series': {
        label: '推理模型',
        match: ['o1', 'o3', 'o4'],
        capabilities: ['llm.responses', 'llm.responses.stream', 'llm.tools'],
        uiSchemas: ['openai-responses', 'openai-reasoning'],
      },
      'gpt-image': {
        label: 'GPT Image',
        match: ['gpt-image'],
        capabilities: ['image.generate', 'image.edit'],
        uiSchemas: ['openai-image-generate', 'openai-image-edit'],
        operationPreference: ['image.generate', 'image.edit'],
      },
      'dall-e-3': {
        label: 'DALL·E 3',
        capabilities: ['image.generate'],
        uiSchemas: ['openai-image-generate'],
        operationPreference: ['image.generate'],
      },
      'dall-e-2': {
        label: 'DALL·E 2',
        capabilities: ['image.generate', 'image.edit'],
        uiSchemas: ['openai-image-generate', 'openai-image-edit'],
        operationPreference: ['image.generate', 'image.edit'],
      },
      ...Object.fromEntries(OPENAI_MINIMAX_VIDEO_PROFILES.map((profile) => [profile.id, {
        label: `${profile.label} / OpenAI Compatible`, match: [profile.id],
        capabilities: ['video.generate', 'video.text_to_video', 'video.image_to_video'],
        uiSchemas: ['openai-video-generate'], operationPreference: ['video.generate', 'video.image_to_video'],
        limits: profile.limits, defaults: profile.defaults,
      }])),
      sora: {
        label: 'Sora / OpenAI 视频',
        match: ['sora'],
        capabilities: ['video.generate', 'video.text_to_video', 'video.image_to_video'],
        uiSchemas: ['openai-video-generate'],
        operationPreference: ['video.generate', 'video.image_to_video'],
      },
      embedding: {
        label: 'Embedding 模型',
        match: ['text-embedding', 'embedding'],
        capabilities: ['embeddings.create', 'rag.embeddings'],
        uiSchemas: ['openai-embeddings'],
        operationPreference: ['embeddings.create'],
      },
      tts: {
        label: 'TTS 语音合成',
        match: ['tts', 'gpt-4o-mini-tts'],
        capabilities: ['audio.tts'],
        uiSchemas: ['openai-audio-speech'],
        operationPreference: ['audio.tts'],
      },
      whisper: {
        label: 'Whisper / 语音识别',
        match: ['whisper', 'gpt-4o-transcribe', 'gpt-4o-mini-transcribe'],
        capabilities: ['audio.transcribe', 'audio.translate'],
        uiSchemas: ['openai-audio-transcribe'],
        operationPreference: ['audio.transcribe'],
      },
      moderation: {
        label: 'Moderation',
        match: ['omni-moderation', 'text-moderation', 'moderation'],
        capabilities: ['moderation.create'],
        operationPreference: ['moderation.create'],
      },
    },
    uiSchemas: {
      'openai-chat': [
        { key: 'temperature', label: '温度', type: 'slider', default: 0.7, min: 0, max: 2, step: 0.1, bind: 'body.temperature' },
        { key: 'top_p', label: 'Top P', type: 'slider', default: 1, min: 0, max: 1, step: 0.05, bind: 'body.top_p' },
        { key: 'max_tokens', label: '最大输出', type: 'number', default: 1024, min: 1, max: 128000, bind: 'body.max_tokens' },
        { key: 'response_format', label: '输出格式', type: 'select', default: 'text', options: [{ label: '文本', value: 'text' }, { label: 'JSON Object', value: 'json_object' }], bind: 'body.response_format.type' },
      ],
      'openai-chat-stream': [
        { key: 'stream', label: '流式返回', type: 'toggle', default: true, readonly: true, bind: 'body.stream' },
        { key: 'temperature', label: '温度', type: 'slider', default: 0.7, min: 0, max: 2, step: 0.1, bind: 'body.temperature' },
        { key: 'max_tokens', label: '最大输出', type: 'number', default: 1024, min: 1, max: 128000, bind: 'body.max_tokens' },
      ],
      'openai-vision': [
        { key: 'image_detail', label: '图片细节', type: 'select', default: 'auto', options: [{ label: '自动', value: 'auto' }, { label: '低', value: 'low' }, { label: '高', value: 'high' }], bind: 'body.messages[].content[].image_url.detail' },
        { key: 'max_tokens', label: '最大输出', type: 'number', default: 1024, min: 1, max: 128000, bind: 'body.max_tokens' },
      ],
      'openai-tools': [
        { key: 'tool_choice', label: '工具选择', type: 'select', default: 'auto', options: [{ label: '自动', value: 'auto' }, { label: '必须调用', value: 'required' }, { label: '不调用', value: 'none' }], bind: 'body.tool_choice' },
        { key: 'parallel_tool_calls', label: '并行工具', type: 'toggle', default: true, bind: 'body.parallel_tool_calls' },
      ],
      'openai-structured-output': [
        { key: 'schema_name', label: 'Schema 名称', type: 'text', default: 'response_schema', bind: 'body.response_format.json_schema.name' },
        { key: 'strict', label: '严格模式', type: 'toggle', default: true, bind: 'body.response_format.json_schema.strict' },
        { key: 'json_schema', label: 'JSON Schema', type: 'json', default: {}, bind: 'body.response_format.json_schema.schema' },
      ],
      'openai-responses': [
        { key: 'instructions', label: '系统指令', type: 'textarea', default: '', bind: 'body.instructions' },
        { key: 'temperature', label: '温度', type: 'slider', default: 0.7, min: 0, max: 2, step: 0.1, bind: 'body.temperature' },
        { key: 'top_p', label: 'Top P', type: 'slider', default: 1, min: 0, max: 1, step: 0.05, bind: 'body.top_p' },
        { key: 'max_output_tokens', label: '最大输出', type: 'number', default: 2048, min: 1, max: 128000, bind: 'body.max_output_tokens' },
        { key: 'text_format', label: '文本格式', type: 'select', default: 'text', options: [{ label: '文本', value: 'text' }, { label: 'JSON Schema', value: 'json_schema' }], bind: 'body.text.format.type' },
      ],
      'openai-responses-stream': [
        { key: 'stream', label: '流式返回', type: 'toggle', default: true, readonly: true, bind: 'body.stream' },
        { key: 'max_output_tokens', label: '最大输出', type: 'number', default: 2048, min: 1, max: 128000, bind: 'body.max_output_tokens' },
      ],
      'openai-reasoning': [
        { key: 'reasoning_effort', label: '推理强度', type: 'select', default: 'medium', options: [{ label: '低', value: 'low' }, { label: '中', value: 'medium' }, { label: '高', value: 'high' }], bind: 'body.reasoning.effort' },
      ],
      'openai-image-generate': [
        { key: 'size', label: '尺寸', type: 'select', default: '1024x1024', options: ['auto', '1024x1024', '1024x1536', '1536x1024', '1792x1024', '1024x1792'].map((value) => ({ label: value === 'auto' ? '自动' : value, value })), bind: 'body.size' },
        { key: 'quality', label: '质量', type: 'select', default: 'auto', options: [{ label: '自动', value: 'auto' }, { label: '低', value: 'low' }, { label: '中', value: 'medium' }, { label: '极高', value: 'xhigh' }, { label: '最高', value: 'max' }, { label: '标准', value: 'standard' }, { label: '高清', value: 'hd' }, { label: '高质量', value: 'high' }], bind: 'body.quality' },
        { key: 'n', label: '数量', type: 'number', default: 1, min: 1, max: 4, bind: 'body.n' },
        { key: 'response_format', label: '返回格式', type: 'select', default: 'url', options: [{ label: 'URL', value: 'url' }, { label: 'Base64', value: 'b64_json' }], bind: 'body.response_format' },
      ],
      'openai-image-edit': [
        { key: 'size', label: '尺寸', type: 'select', default: '1024x1024', options: ['auto', '1024x1024', '1024x1536', '1536x1024'].map((value) => ({ label: value === 'auto' ? '自动' : value, value })), bind: 'form.size' },
        { key: 'quality', label: '质量', type: 'select', default: 'auto', options: [{ label: '自动', value: 'auto' }, { label: '低', value: 'low' }, { label: '中', value: 'medium' }, { label: '极高', value: 'xhigh' }, { label: '最高', value: 'max' }, { label: '标准', value: 'standard' }, { label: '高质量', value: 'high' }], bind: 'form.quality' },
        { key: 'n', label: '数量', type: 'number', default: 1, min: 1, max: 4, bind: 'form.n' },
      ],
      'openai-video-generate': [
        { key: 'duration', label: '时长（秒）', type: 'number', default: 5, min: 1, max: 30, step: 1, bind: 'body.duration' },
        { key: 'aspect_ratio', label: '比例', type: 'select', default: '16:9', options: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'].map((value) => ({ label: value, value })), bind: 'body.aspect_ratio' },
        { key: 'resolution', label: '清晰度', type: 'select', default: '720p', options: ['480p', '720p', '1080p', '4k'].map((value) => ({ label: value.toUpperCase(), value })), bind: 'body.resolution' },
        { key: 'enhance_prompt', label: '增强提示词', type: 'toggle', default: false, bind: 'body.enhance_prompt' },
      ],
      'openai-audio-speech': [
        { key: 'voice', label: '声音', type: 'select', default: 'alloy', options: ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer'].map((value) => ({ label: value, value })), bind: 'body.voice' },
        { key: 'response_format', label: '格式', type: 'select', default: 'mp3', options: ['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'].map((value) => ({ label: value.toUpperCase(), value })), bind: 'body.response_format' },
        { key: 'speed', label: '语速', type: 'slider', default: 1, min: 0.25, max: 4, step: 0.05, bind: 'body.speed' },
      ],
      'openai-audio-transcribe': [
        { key: 'language', label: '语言', type: 'text', default: '', bind: 'form.language' },
        { key: 'prompt', label: '提示词', type: 'textarea', default: '', bind: 'form.prompt' },
        { key: 'response_format', label: '返回格式', type: 'select', default: 'json', options: ['json', 'text', 'srt', 'verbose_json', 'vtt'].map((value) => ({ label: value, value })), bind: 'form.response_format' },
        { key: 'temperature', label: '温度', type: 'slider', default: 0, min: 0, max: 1, step: 0.1, bind: 'form.temperature' },
      ],
      'openai-embeddings': [
        { key: 'encoding_format', label: '编码', type: 'select', default: 'float', options: [{ label: 'Float', value: 'float' }, { label: 'Base64', value: 'base64' }], bind: 'body.encoding_format' },
        { key: 'dimensions', label: '维度', type: 'number', default: 0, min: 0, max: 4096, bind: 'body.dimensions' },
      ],
      'openai-files': [
        { key: 'purpose', label: '用途', type: 'select', default: 'batch', options: ['batch', 'fine-tune', 'assistants', 'vision'].map((value) => ({ label: value, value })), bind: 'form.purpose' },
      ],
      'openai-batches': [
        { key: 'endpoint', label: '端点', type: 'select', default: '/v1/chat/completions', options: ['/v1/chat/completions', '/v1/responses', '/v1/embeddings'].map((value) => ({ label: value, value })), bind: 'body.endpoint' },
        { key: 'completion_window', label: '完成窗口', type: 'select', default: '24h', options: [{ label: '24h', value: '24h' }], bind: 'body.completion_window' },
        { key: 'input_file_id', label: '输入文件', type: 'text', default: '', bind: 'body.input_file_id' },
        { key: 'metadata', label: '元数据', type: 'json', default: {}, bind: 'body.metadata' },
      ],
    },
    paramSchema: {
      llm: [
        { key: 'temperature', label: '温度', type: 'slider', default: 0.7, min: 0, max: 2, step: 0.1 },
        { key: 'max_tokens', label: '最大输出', type: 'number', default: 1024, min: 1, max: 128000 },
      ],
      image: [
        {
          key: 'quality',
          label: '质量',
          type: 'select',
          default: 'auto',
          options: [
            { label: '自动', value: 'auto' },
            { label: '标准', value: 'standard' },
            { label: '高质量', value: 'high' },
          ],
          showWhen: { models: ['gpt-image-1'] },
        },
      ],
    },
    docs: [
      { title: 'Chat Completions', url: 'https://gpt-best.apifox.cn/api-139393491' },
      { title: 'Chat Completions Stream', url: 'https://gpt-best.apifox.cn/api-287782769' },
      { title: 'Responses', url: 'https://gpt-best.apifox.cn/api-321434971' },
      { title: 'Responses Stream', url: 'https://gpt-best.apifox.cn/api-321434972' },
      { title: 'Images Generations', url: 'https://gpt-best.apifox.cn/api-302915860' },
      { title: 'Images Edits', url: 'https://gpt-best.apifox.cn/api-302915861' },
      { title: 'Video Generations', url: 'https://gpt-best.apifox.cn/doc-7324259' },
      { title: 'Audio Speech', url: 'https://gpt-best.apifox.cn/doc-6113929' },
      { title: 'Audio Transcriptions', url: 'https://gpt-best.apifox.cn/doc-6113929' },
      { title: 'Embeddings', url: 'https://gpt-best.apifox.cn/doc-6113929' },
      { title: 'Files', url: 'https://gpt-best.apifox.cn/doc-6113929' },
      { title: 'Batches', url: 'https://gpt-best.apifox.cn/doc-6113929' },
    ],
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic Claude',
    summary: 'Anthropic Messages 官方协议：x-api-key + anthropic-version 2023-06-01，/v1/messages 文本、视觉与具名 SSE 流式。',
    categories: ['llm', 'vision', 'tools'],
    auth: { type: 'api_key_header', header: 'x-api-key' },
    headers: { 'anthropic-version': '2023-06-01' },
    models: { endpoint: '/v1/models', kind: 'anthropic' },
    // 注意：这里**不设 def.stream** —— legacy-executor-chat.cjs:124 会据此强制 OpenAI 形状 SSE 累积，
    // Anthropic 的具名事件不适用；流式声明放在 operations['llm.chat.stream']。
    capabilities: {
      llm: { endpoint: '/v1/messages', body: 'anthropic_messages', parse: 'anthropic_text' },
      vlm: { endpoint: '/v1/messages', body: 'anthropic_messages', parse: 'anthropic_text' },
    },
    operations: {
      'llm.chat': {
        label: 'Messages',
        method: 'POST',
        path: '/v1/messages',
        requestMode: 'json',
        bodyTemplate: {
          model: '{{model}}',
          max_tokens: '{{params.max_tokens}}',
          system: '{{system}}',
          messages: '{{messages}}',
          temperature: '{{params.temperature}}',
          top_p: '{{params.top_p}}',
        },
        response: {
          text: '$.content[*].text',
          finishReason: '$.stop_reason',
          usage: '$.usage',
        },
        uiSchema: 'anthropic-chat',
      },
      'llm.chat.stream': {
        label: 'Messages Stream',
        method: 'POST',
        path: '/v1/messages',
        requestMode: 'json',
        bodyTemplate: {
          model: '{{model}}',
          max_tokens: '{{params.max_tokens}}',
          system: '{{system}}',
          messages: '{{messages}}',
          stream: true,
          temperature: '{{params.temperature}}',
        },
        stream: {
          protocol: 'sse',
          namedEvents: true,
          eventNames: ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop', 'error'],
          usageEvents: ['message_start', 'message_delta'],
          deltaTextEvents: ['content_block_delta'],
          deltaText: '$.delta.text',
          doneEvents: ['message_stop'],
          errorEvents: ['error'],
        },
        uiSchema: 'anthropic-chat-stream',
      },
      'llm.chat.vision': {
        label: 'Messages Vision',
        method: 'POST',
        path: '/v1/messages',
        requestMode: 'json',
        bodyTemplate: {
          model: '{{model}}',
          max_tokens: '{{params.max_tokens}}',
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: '{{prompt}}' },
                { type: 'image', source: { type: 'base64', media_type: '{{inputs.mediaType}}', data: '{{inputs.base64}}' } },
              ],
            },
          ],
        },
        response: {
          text: '$.content[*].text',
          usage: '$.usage',
        },
        uiSchema: 'anthropic-vision',
      },
    },
    paramSchema: {
      llm: [
        { key: 'max_tokens', label: '最大输出', type: 'number', default: 1024, min: 1, max: 200000 },
      ],
    },
    docs: [
      { title: 'Messages', url: 'https://platform.claude.com/docs/en/api/messages' },
      { title: 'Streaming Messages', url: 'https://platform.claude.com/docs/en/build-with-claude/streaming' },
      { title: 'Models List', url: 'https://platform.claude.com/docs/en/api/models/list' },
      { title: 'Model IDs and versions', url: 'https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions' },
    ],
  },
  gemini: {
    id: 'gemini',
    label: 'Google Gemini',
    summary: 'Google Gemini generateContent 协议，覆盖文本、视觉理解和 Gemini 图像生成。',
    auth: { type: 'google_api_key', header: 'x-goog-api-key' },
    models: { endpoint: '/v1beta/models', kind: 'gemini' },
    capabilities: {
      llm: { endpoint: '/v1beta/models/{model}:generateContent', body: 'gemini_content', parse: 'gemini_text' },
      vlm: { endpoint: '/v1beta/models/{model}:generateContent', body: 'gemini_content', parse: 'gemini_text' },
    },
    operations: {
      'llm.chat': {
        label: 'Generate Content',
        method: 'POST',
        path: '/v1beta/models/{model}:generateContent',
        requestMode: 'json',
        bodyTemplate: {
          contents: '{{messages}}',
          generationConfig: '{{params.generationConfig}}',
        },
        response: { text: '$.candidates[0].content.parts[0].text', usage: '$.usageMetadata' },
      },
      'llm.chat.vision': {
        label: 'Generate Content Vision',
        method: 'POST',
        path: '/v1beta/models/{model}:generateContent',
        requestMode: 'json',
        bodyTemplate: {
          contents: '{{messagesWithImages}}',
          generationConfig: '{{params.generationConfig}}',
        },
        response: { text: '$.candidates[0].content.parts[0].text', usage: '$.usageMetadata' },
      },
      'image.generate': {
        label: 'Gemini Image Generation',
        method: 'POST',
        path: '/v1beta/models/{model}:generateContent',
        requestMode: 'json',
        derive: GEMINI_IMAGE_DERIVE,
        bodyTemplate: {
          contents: [{ role: 'user', parts: [{ text: '{{prompt}}' }] }],
          generationConfig: {
            responseModalities: ['TEXT', 'IMAGE'],
            imageConfig: {
              aspectRatio: '{{derived.aspectRatio}}',
              imageSize: '{{derived.imageSize}}',
            },
          },
        },
        response: { images: '$.candidates[*].content.parts[*].inlineData.data' },
        uiSchema: 'gemini-image-generate',
      },
      'image.edit': {
        label: 'Gemini Image Edit',
        method: 'POST',
        path: '/v1beta/models/{model}:generateContent',
        requestMode: 'json',
        uiSchema: 'gemini-image-generate',
      },
    },
    modelProfiles: {
      'gemini-image': {
        label: 'Gemini Image',
        match: ['gemini-2.0-flash-preview-image', 'gemini-2.5-flash-image', 'imagen'],
        capabilities: ['image.generate', 'image.edit'],
        uiSchemas: ['gemini-image-generate'],
        operationPreference: ['image.generate', 'image.edit'],
      },
    },
    uiSchemas: {
      'gemini-image-generate': [
        { key: 'aspect_ratio', label: '比例', type: 'select', default: '1:1', options: ['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9', '21:9', '9:21'].map((value) => ({ label: value, value })), bind: 'body.generationConfig.imageConfig.aspectRatio' },
        { key: 'resolution', label: '清晰度', type: 'select', default: '1k', options: ['1k', '2k', '4k'].map((value) => ({ label: value.toUpperCase(), value })), bind: 'body.generationConfig.imageConfig.imageSize' },
      ],
    },
    paramSchema: {
      llm: [
        { key: 'temperature', label: '温度', type: 'slider', default: 0.7, min: 0, max: 2, step: 0.1 },
      ],
      image: [
        { key: 'aspect_ratio', label: '比例', type: 'select', default: '1:1', options: ['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9', '21:9', '9:21'].map((value) => ({ label: value, value })) },
        { key: 'resolution', label: '清晰度', type: 'select', default: '1k', options: ['1k', '2k', '4k'].map((value) => ({ label: value.toUpperCase(), value })) },
      ],
    },
  },
  'gemini-generations': {
    id: 'gemini-generations',
    label: 'Gemini Generations',
    kind: 'model-protocol-package',
    scope: 'model',
    runtimeProtocol: 'openai',
    summary: '中转站 Gemini 图片协议：文生图和参考图编辑统一使用 JSON 格式的 /v1/images/generations；不同于 Gemini 官方 generateContent。',
    categories: ['image'],
    auth: { type: 'bearer', header: 'Authorization', prefix: 'Bearer ' },
    models: { endpoint: '/v1/models', kind: 'openai' },
    capabilities: {
      image: { endpoint: '/v1/images/generations', body: 'openai_chat', parse: 'openai_chat' },
    },
    operations: {
      'image.generate': {
        label: 'Gemini Generations 文生图', method: 'POST', path: '/v1/images/generations', requestMode: 'json',
        bodyTemplate: { model: '{{model}}', prompt: '{{prompt}}', n: '{{params.n}}', size: '{{params.size}}', aspect_ratio: '{{params.aspect_ratio}}' },
        response: { images: '$.data[*].url || $.data[*].b64_json' }, uiSchema: 'gemini-generations-image',
      },
      'image.edit': {
        label: 'Gemini Generations 参考图编辑', method: 'POST', path: '/v1/images/generations', requestMode: 'json',
        bodyTemplate: { model: '{{model}}', prompt: '{{prompt}}', image: '{{inputs.imageUrls}}', n: '{{params.n}}', size: '{{params.size}}', aspect_ratio: '{{params.aspect_ratio}}' },
        response: { images: '$.data[*].url || $.data[*].b64_json' }, uiSchema: 'gemini-generations-image',
      },
    },
    modelProfiles: {
      gemini: {
        label: 'Gemini Generations Image', match: ['gemini', 'nano-banana'],
        capabilities: ['image.generate', 'image.edit'],
        uiSchemas: ['gemini-generations-image'],
        operationPreference: ['image.generate', 'image.edit'],
      },
    },
    uiSchemas: {
      'gemini-generations-image': [
        { key: 'aspect_ratio', label: '比例', type: 'select', default: '1:1', options: ['1:1', '4:3', '3:4', '16:9', '9:16'].map((value) => ({ label: value, value })), bind: 'body.aspect_ratio' },
        { key: 'size', label: '尺寸', type: 'select', default: '1024x1024', options: ['1024x1024', '1024x1536', '1536x1024'].map((value) => ({ label: value, value })), bind: 'body.size' },
        { key: 'n', label: '数量', type: 'number', default: 1, min: 1, max: 4, bind: 'body.n' },
      ],
    },
    paramSchema: {
      image: [
        { key: 'aspect_ratio', label: '比例', type: 'select', default: '1:1', options: ['1:1', '4:3', '3:4', '16:9', '9:16'].map((value) => ({ label: value, value })) },
        { key: 'size', label: '尺寸', type: 'select', default: '1024x1024', options: ['1024x1024', '1024x1536', '1536x1024'].map((value) => ({ label: value, value })) },
        { key: 'n', label: '数量', type: 'number', default: 1, min: 1, max: 4 },
      ],
    },
    docs: [{ title: 'GPT-Best Generations 通用', url: 'https://gpt-best.apifox.cn/api-302915860' }],
  },
  'gpt-best-images': {
    id: 'gpt-best-images',
    label: 'GPT-Best Images',
    kind: 'model-protocol-package',
    scope: 'model',
    runtimeProtocol: 'openai',
    summary: 'GPT-Best 的 OpenAI Images 扩展；旧模式保持同步 OpenAI 兼容，Agent 模式使用独立异步提交与查询协议。',
    categories: ['image'],
    auth: { type: 'bearer', header: 'Authorization', prefix: 'Bearer ' },
    models: { endpoint: '/v1/models', kind: 'openai' },
    capabilities: { image: { endpoint: '/v1/images/generations', body: 'openai_chat', parse: 'openai_chat' } },
    operations: {
      'image.generate': { label: 'GPT-Best Images Generations', method: 'POST', path: '/v1/images/generations', requestMode: 'json', uiSchema: 'gpt-best-image' },
      'image.edit': { label: 'GPT-Best Images Edits', method: 'POST', path: '/v1/images/edits', requestMode: 'multipart', uiSchema: 'gpt-best-image' },
    },
    modelProfiles: {
      images: {
        label: 'GPT-Best Images',
        match: ['gpt-image', 'dall-e-', 'nano-banana', 'gemini-', 'qwen-image', 'seedream', 'flux', 'recraft', 'grok-', 'ideogram', 'jimeng', 'kolors', 'photon', 'cogview', 'sora_image'],
        capabilities: ['image.generate', 'image.edit'], uiSchemas: ['gpt-best-image'], operationPreference: ['image.generate', 'image.edit'],
      },
    },
    uiSchemas: {
      'gpt-best-image': [
        { key: 'size', label: '图片尺寸', type: 'text', default: '1024x1024', bind: 'body.size' },
        { key: 'quality', label: '质量', type: 'select', default: 'auto', options: ['auto', 'low', 'medium', 'high'].map((value) => ({ label: value, value })), bind: 'body.quality' },
        { key: 'n', label: '数量', type: 'number', default: 1, min: 1, max: 10, bind: 'body.n' },
      ],
    },
    paramSchema: {
      image: [
        { key: 'size', label: '图片尺寸', type: 'text', default: '1024x1024' },
        { key: 'quality', label: '质量', type: 'select', default: 'auto', options: ['auto', 'low', 'medium', 'high'].map((value) => ({ label: value, value })) },
        { key: 'n', label: '数量', type: 'number', default: 1, min: 1, max: 10 },
      ],
    },
    docs: [
      { title: 'GPT-Best 异步图片提交', url: 'https://gpt-best.apifox.cn/api-356258955' },
      { title: 'GPT-Best 异步图片查询', url: 'https://gpt-best.apifox.cn/api-356258956' },
    ],
  },
  apimart: {
    id: 'apimart',
    label: '异步模型协议',
    summary: '统一收纳 APIMart、APIB 等异步聚合平台的 OpenAI 对话、Gemini、Claude、图片、视频与音乐模型格式。',
    auth: { type: 'bearer', header: 'Authorization', prefix: 'Bearer ' },
    unwrapData: true,
    models: { endpoint: '/v1/models', kind: 'openai' },
    stream: true,
    capabilities: {
      llm: { endpoint: '/v1/chat/completions', body: 'openai_chat', parse: 'openai_chat' },
      vlm: { endpoint: '/v1/chat/completions', body: 'openai_chat', parse: 'openai_chat' },
    },
    operations: {
      'llm.chat': {
        label: 'APIMart OpenAI Chat',
        method: 'POST',
        path: '/v1/chat/completions',
        requestMode: 'json',
        bodyTemplate: {
          model: '{{model}}',
          messages: '{{messages}}',
          temperature: '{{params.temperature}}',
          top_p: '{{params.top_p}}',
          max_tokens: '{{params.max_tokens}}',
        },
        response: { text: '$.choices[0].message.content', usage: '$.usage' },
        uiSchema: 'openai-chat',
      },
      'llm.chat.vision': {
        label: 'APIMart OpenAI Vision',
        method: 'POST',
        path: '/v1/chat/completions',
        requestMode: 'json',
        bodyTemplate: {
          model: '{{model}}',
          messages: '{{messages}}',
          temperature: '{{params.temperature}}',
          max_tokens: '{{params.max_tokens}}',
        },
        response: { text: '$.choices[0].message.content', usage: '$.usage' },
        uiSchema: 'openai-vision',
      },
      'image.generate': {
        label: 'APIMart Image Generations',
        method: 'POST',
        path: '/v1/images/generations',
        requestMode: 'json',
        derive: GEMINI_IMAGE_DERIVE,
        bodyTemplate: {
          model: '{{model}}', prompt: '{{prompt}}', n: '{{params.n}}',
          size: '{{derived.aspectRatio}}', resolution: '{{derived.imageSize}}',
          nsfw_check: '{{params.nsfw_check}}', official_fallback: '{{params.official_fallback}}',
        },
        response: { taskId: '$.data[0].task_id || $.data.task_id || $.task_id', images: '$.data.result.images[*].url[*]' },
        uiSchema: 'apimart-image-generate',
      },
      'image.edit': {
        label: 'APIMart Image Edit',
        method: 'POST',
        path: '/v1/images/generations',
        requestMode: 'json',
        derive: GEMINI_IMAGE_DERIVE,
        bodyTemplate: {
          model: '{{model}}', prompt: '{{prompt}}', n: '{{params.n}}', image_urls: '{{inputs.imageUrls}}',
          size: '{{derived.aspectRatio}}', resolution: '{{derived.imageSize}}',
          nsfw_check: '{{params.nsfw_check}}', official_fallback: '{{params.official_fallback}}',
        },
        response: { taskId: '$.data[0].task_id || $.data.task_id || $.task_id', images: '$.data.result.images[*].url[*]' },
        uiSchema: 'apimart-image-generate',
      },
      'video.generate': {
        label: 'APIMart Video Generations',
        method: 'POST',
        path: '/v1/videos/generations',
        requestMode: 'json',
        bodyTemplate: {
          model: '{{model}}',
          prompt: '{{prompt}}',
          duration: '{{params.duration}}',
          size: '{{params.size}}',
          resolution: '{{params.resolution}}',
          generate_audio: '{{params.generate_audio}}',
        },
        response: {
          taskId: '$.id || $.task_id || $.data.id || $.data.task_id',
          videos: '$..video_url || $..url',
        },
        uiSchema: 'apimart-video-generate',
      },
      'video.image_to_video': {
        label: 'APIMart Image To Video',
        method: 'POST',
        path: '/v1/videos/generations',
        requestMode: 'json',
        bodyTemplate: {
          model: '{{model}}',
          prompt: '{{prompt}}',
          image_urls: '{{inputs.imageUrls}}',
          duration: '{{params.duration}}',
          size: '{{params.size}}',
          resolution: '{{params.resolution}}',
          generate_audio: '{{params.generate_audio}}',
        },
        response: {
          taskId: '$.id || $.task_id || $.data.id || $.data.task_id',
          videos: '$..video_url || $..url',
        },
        uiSchema: 'apimart-video-generate',
      },
      'audio.tts': {
        label: 'APIMart Audio Speech',
        method: 'POST',
        path: '/v1/audio/speech',
        requestMode: 'json',
        bodyTemplate: {
          model: '{{model}}',
          input: '{{input}}',
          voice: '{{params.voice}}',
          response_format: '{{params.response_format}}',
          speed: '{{params.speed}}',
        },
        response: { audio: 'binary', contentType: 'audio/*' },
        uiSchema: 'apimart-audio-speech',
      },
      'audio.transcribe': {
        label: 'APIMart Audio Transcriptions',
        method: 'POST',
        path: '/v1/audio/transcriptions',
        requestMode: 'multipart',
        bodyTemplate: {
          model: '{{model}}',
          file: '{{inputs.audio}}',
          language: '{{params.language}}',
          prompt: '{{params.prompt}}',
          response_format: '{{params.response_format}}',
          temperature: '{{params.temperature}}',
        },
        response: { text: '$.text', segments: '$.segments' },
        uiSchema: 'openai-audio-transcribe',
      },
      'audio.translate': {
        label: 'APIMart Audio Translations',
        method: 'POST',
        path: '/v1/audio/translations',
        requestMode: 'multipart',
        bodyTemplate: {
          model: '{{model}}',
          file: '{{inputs.audio}}',
          prompt: '{{params.prompt}}',
          response_format: '{{params.response_format}}',
          temperature: '{{params.temperature}}',
        },
        response: { text: '$.text' },
        uiSchema: 'openai-audio-transcribe',
      },
      'embeddings.create': {
        label: 'APIMart Embeddings',
        method: 'POST',
        path: '/v1/embeddings',
        requestMode: 'json',
        bodyTemplate: {
          model: '{{model}}',
          input: '{{input}}',
          encoding_format: '{{params.encoding_format}}',
          dimensions: '{{params.dimensions}}',
        },
        response: { embeddings: '$.data[*].embedding', usage: '$.usage' },
        uiSchema: 'openai-embeddings',
      },
      'moderation.create': {
        label: 'APIMart Moderations',
        method: 'POST',
        path: '/v1/moderations',
        requestMode: 'json',
        bodyTemplate: {
          model: '{{model}}',
          input: '{{input}}',
        },
        response: { results: '$.results' },
      },
      'files.upload': {
        label: 'APIMart Files Upload',
        method: 'POST',
        path: '/v1/files',
        requestMode: 'multipart',
        bodyTemplate: {
          file: '{{inputs.file}}',
          purpose: '{{params.purpose}}',
        },
        response: { id: '$.id', filename: '$.filename', purpose: '$.purpose' },
        uiSchema: 'openai-files',
      },
      'batches.create': {
        label: 'APIMart Batches Create',
        method: 'POST',
        path: '/v1/batches',
        requestMode: 'json',
        bodyTemplate: {
          input_file_id: '{{params.input_file_id}}',
          endpoint: '{{params.endpoint}}',
          completion_window: '{{params.completion_window}}',
          metadata: '{{params.metadata}}',
        },
        response: { batch: '$' },
        uiSchema: 'openai-batches',
      },
    },
    modelProfiles: {
      'gpt-4o': {
        label: 'GPT-4o via APIMart',
        capabilities: ['llm.chat', 'llm.chat.vision', 'llm.tools', 'llm.structured_output'],
        uiSchemas: ['openai-chat', 'openai-vision', 'openai-tools'],
      },
      'gpt-5': {
        label: 'GPT-5 via APIMart',
        capabilities: ['llm.chat', 'llm.tools', 'llm.structured_output'],
        uiSchemas: ['openai-chat', 'openai-tools'],
      },
      'gemini-image': {
        label: 'Gemini Image via APIMart',
        match: ['gemini-2.5-flash-image', 'gemini-2.0-flash-preview-image', 'gemini-3', 'imagen'],
        capabilities: ['image.generate', 'image.edit'],
        uiSchemas: ['apimart-image-generate'],
        operationPreference: ['image.generate', 'image.edit'],
      },
      'gpt-image': {
        label: 'GPT Image via APIMart',
        match: ['gpt-image-'],
        capabilities: ['image.generate', 'image.edit'],
        uiSchemas: ['apimart-image-generate'],
        operationPreference: ['image.generate', 'image.edit'],
      },
      'veo3.1-lite': {
        label: 'VEO 3.1 Lite via APIMart',
        capabilities: ['video.generate', 'video.text_to_video'],
        uiSchemas: ['apimart-video-generate'],
        operationPreference: ['video.generate'],
        limits: { ...APIMART_VEO_LIMITS, references: { images: { max: 0 }, videos: { max: 0 }, audios: { max: 0 } } },
      },
      veo: {
        label: 'VEO Video via APIMart',
        match: ['veo'],
        capabilities: ['video.generate', 'video.text_to_video', 'video.image_to_video', 'video.first_last_frame'],
        uiSchemas: ['apimart-video-generate'],
        operationPreference: ['video.generate', 'video.image_to_video'],
        limits: APIMART_VEO_LIMITS,
      },
      'seedance-2.5': APIMART_SEEDANCE25_PROFILE,
      seedance: {
        label: 'Seedance Video via APIMart',
        match: ['doubao-seedance', 'seedance'],
        capabilities: ['video.generate', 'video.text_to_video', 'video.image_to_video', 'video.first_last_frame', 'video.multi_reference', 'video.video_to_video', 'video.audio_reference', 'video.multimodal'],
        uiSchemas: ['apimart-video-generate'],
        operationPreference: ['video.generate', 'video.image_to_video'],
        limits: APIMART_SEEDANCE_LIMITS,
      },
      embedding: {
        label: 'Embedding via APIMart',
        match: ['text-embedding', 'embedding'],
        capabilities: ['embeddings.create'],
        uiSchemas: ['openai-embeddings'],
        operationPreference: ['embeddings.create'],
      },
      tts: {
        label: 'TTS via APIMart',
        match: ['gpt-4o-mini-tts'],
        capabilities: ['audio.tts'],
        uiSchemas: ['apimart-audio-speech'],
        operationPreference: ['audio.tts'],
      },
      whisper: {
        label: 'Whisper via APIMart',
        match: ['whisper', 'transcribe'],
        capabilities: ['audio.transcribe', 'audio.translate'],
        uiSchemas: ['openai-audio-transcribe'],
        operationPreference: ['audio.transcribe'],
      },
      moderation: {
        label: 'Moderation via APIMart',
        match: ['moderation'],
        capabilities: ['moderation.create'],
        operationPreference: ['moderation.create'],
      },
    },
    uiSchemas: {
      'apimart-image-generate': [
        { key: 'aspect_ratio', label: '比例', type: 'select', default: '1:1', options: ['auto', '1:1', '2:3', '3:2', '3:4', '4:3', '5:4', '4:5', '9:16', '16:9', '2:1', '1:2', '3:1', '1:3', '21:9', '9:21'].map((value) => ({ label: value, value })), bind: 'body.size' },
        { key: 'resolution', label: '清晰度', type: 'select', default: '1k', options: ['1k', '2k', '4k'].map((value) => ({ label: value.toUpperCase(), value })), bind: 'body.resolution' },
        { key: 'nsfw_check', label: '提交前内容审核', type: 'toggle', default: false, bind: 'body.nsfw_check' },
        { key: 'official_fallback', label: '官方渠道兜底', type: 'toggle', default: false, bind: 'body.official_fallback' },
      ],
      'apimart-video-generate': [
        { key: 'duration', label: '时长', type: 'select', default: 5, options: Array.from({ length: 12 }, (_, index) => index + 4).map((value) => ({ label: `${value}s`, value })), bind: 'body.duration' },
        { key: 'size', label: '比例', type: 'select', default: '16:9', options: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'adaptive'].map((value) => ({ label: value, value })), bind: 'body.size' },
        { key: 'resolution', label: '清晰度', type: 'select', default: '720p', options: ['480p', '720p', '1080p', '4k'].map((value) => ({ label: value.toUpperCase(), value })), bind: 'body.resolution' },
        { key: 'generate_audio', label: '生成音频', type: 'toggle', default: true, bind: 'body.generate_audio' },
        { key: 'return_last_frame', label: '返回尾帧', type: 'toggle', default: false, bind: 'body.return_last_frame' },
      ],
      'openai-audio-speech': [
        { key: 'voice', label: '声音', type: 'select', default: 'alloy', options: ['alloy', 'echo', 'nova', 'shimmer'].map((value) => ({ label: value, value })), bind: 'body.voice' },
        { key: 'response_format', label: '格式', type: 'select', default: 'mp3', options: ['mp3', 'wav', 'flac', 'opus'].map((value) => ({ label: value.toUpperCase(), value })), bind: 'body.response_format' },
        { key: 'speed', label: '速度', type: 'slider', default: 1, min: 0.25, max: 4, step: 0.05, bind: 'body.speed' },
      ],
      'apimart-audio-speech': [
        { key: 'voice', label: '声音', type: 'select', default: 'alloy', options: ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'].map((value) => ({ label: value, value })), bind: 'body.voice' },
        { key: 'response_format', label: '格式', type: 'select', default: 'wav', options: ['wav', 'opus', 'aac', 'flac', 'pcm'].map((value) => ({ label: value.toUpperCase(), value })), bind: 'body.response_format' },
        { key: 'speed', label: '速度', type: 'slider', default: 1, min: 0.25, max: 4, step: 0.05, bind: 'body.speed' },
      ],
      'openai-audio-transcribe': [
        { key: 'language', label: '语言', type: 'text', default: '', bind: 'body.language' },
        { key: 'response_format', label: '格式', type: 'select', default: 'json', options: ['json', 'text', 'srt', 'verbose_json', 'vtt'].map((value) => ({ label: value, value })), bind: 'body.response_format' },
        { key: 'temperature', label: '温度', type: 'slider', default: 0, min: 0, max: 1, step: 0.1, bind: 'body.temperature' },
      ],
      'openai-embeddings': [
        { key: 'encoding_format', label: '编码', type: 'select', default: 'float', options: [{ label: 'Float', value: 'float' }, { label: 'Base64', value: 'base64' }], bind: 'body.encoding_format' },
        { key: 'dimensions', label: '维度', type: 'number', default: 0, min: 0, max: 4096, bind: 'body.dimensions' },
      ],
      'openai-files': [
        { key: 'purpose', label: '用途', type: 'select', default: 'batch', options: ['batch', 'fine-tune', 'assistants', 'vision'].map((value) => ({ label: value, value })), bind: 'body.purpose' },
      ],
      'openai-batches': [
        { key: 'endpoint', label: '端点', type: 'select', default: '/v1/chat/completions', options: ['/v1/chat/completions', '/v1/responses', '/v1/embeddings'].map((value) => ({ label: value, value })), bind: 'body.endpoint' },
        { key: 'completion_window', label: '完成窗口', type: 'select', default: '24h', options: [{ label: '24h', value: '24h' }], bind: 'body.completion_window' },
      ],
    },
    paramSchema: {
      image: [
        { key: 'aspect_ratio', label: '比例', type: 'select', default: '1:1', options: ['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9', '21:9', '9:21'].map((value) => ({ label: value, value })) },
        { key: 'resolution', label: '清晰度', type: 'select', default: '1k', options: ['1k', '2k', '4k'].map((value) => ({ label: value.toUpperCase(), value })) },
      ],
      video: [
        { key: 'duration', label: '时长', type: 'select', default: 5, options: [5, 8, 10].map((value) => ({ label: `${value}s`, value })) },
        { key: 'generate_audio', label: '生成音频', type: 'toggle', default: false },
      ],
      audio: [
        { key: 'voice', label: '声音', type: 'select', default: 'alloy', options: ['alloy', 'echo', 'nova', 'shimmer'].map((value) => ({ label: value, value })) },
        { key: 'response_format', label: '格式', type: 'select', default: 'mp3', options: ['mp3', 'wav', 'flac'].map((value) => ({ label: value.toUpperCase(), value })) },
      ],
      embedding: [
        { key: 'encoding_format', label: '编码', type: 'select', default: 'float', options: [{ label: 'Float', value: 'float' }, { label: 'Base64', value: 'base64' }] },
        { key: 'dimensions', label: '维度', type: 'number', default: 0, min: 0, max: 4096 },
      ],
      files: [
        { key: 'purpose', label: '用途', type: 'select', default: 'batch', options: ['batch', 'fine-tune', 'assistants', 'vision'].map((value) => ({ label: value, value })) },
      ],
      batches: [
        { key: 'endpoint', label: '端点', type: 'select', default: '/v1/chat/completions', options: ['/v1/chat/completions', '/v1/responses', '/v1/embeddings'].map((value) => ({ label: value, value })) },
        { key: 'completion_window', label: '完成窗口', type: 'select', default: '24h', options: [{ label: '24h', value: '24h' }] },
      ],
    },
  },
  'apimart-gemini': {
    id: 'apimart-gemini',
    label: 'Gemini 原生格式（异步平台）',
    summary: '异步聚合平台上的 Gemini generateContent 原生格式，适合需要 Gemini 请求体的文本、视觉和图像模型。',
    kind: 'model-protocol-package',
    scope: 'model',
    auth: { type: 'bearer', header: 'Authorization', prefix: 'Bearer ' },
    unwrapData: true,
    models: { endpoint: '/v1/models', kind: 'openai' },
    capabilities: {
      llm: { endpoint: 'https://api.apimart.ai/v1beta/models/{model}:generateContent', body: 'gemini_content', parse: 'gemini_text' },
      vlm: { endpoint: 'https://api.apimart.ai/v1beta/models/{model}:generateContent', body: 'gemini_content', parse: 'gemini_text' },
    },
    operations: {
      'llm.chat': {
        label: 'APIMart Gemini Generate Content',
        method: 'POST',
        path: 'https://api.apimart.ai/v1beta/models/{model}:generateContent',
        requestMode: 'json',
        bodyTemplate: { contents: '{{messages}}', generationConfig: '{{params.generationConfig}}' },
        response: { text: '$.candidates[0].content.parts[0].text', usage: '$.usageMetadata' },
      },
      'llm.chat.vision': {
        label: 'APIMart Gemini Vision',
        method: 'POST',
        path: 'https://api.apimart.ai/v1beta/models/{model}:generateContent',
        requestMode: 'json',
        bodyTemplate: { contents: '{{messagesWithImages}}', generationConfig: '{{params.generationConfig}}' },
        response: { text: '$.candidates[0].content.parts[0].text', usage: '$.usageMetadata' },
      },
      'image.generate': {
        label: 'APIMart Gemini Image',
        method: 'POST',
        path: 'https://api.apimart.ai/v1beta/models/{model}:generateContent',
        requestMode: 'json',
        derive: GEMINI_IMAGE_DERIVE,
        bodyTemplate: {
          contents: [{ role: 'user', parts: [{ text: '{{prompt}}' }] }],
          generationConfig: {
            responseModalities: ['TEXT', 'IMAGE'],
            imageConfig: { aspectRatio: '{{derived.aspectRatio}}', imageSize: '{{derived.imageSize}}' },
          },
        },
        response: { images: '$.candidates[*].content.parts[*].inlineData.data' },
        uiSchema: 'apimart-image-generate',
      },
    },
    modelProfiles: {
      gemini: { label: 'Gemini via APIMart', match: ['gemini'], capabilities: ['llm.chat', 'llm.chat.vision', 'llm.tools'], uiSchemas: [] },
      imagen: { label: 'Gemini / Imagen Image via APIMart', match: ['imagen', 'gemini-2.5-flash-image', 'gemini-2.0-flash-preview-image'], capabilities: ['image.generate', 'image.edit'], uiSchemas: ['apimart-image-generate'], operationPreference: ['image.generate', 'image.edit'] },
    },
    uiSchemas: {
      'apimart-image-generate': [
        { key: 'aspect_ratio', label: '比例', type: 'select', default: '1:1', options: ['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9', '21:9', '9:21'].map((value) => ({ label: value, value })), bind: 'body.generationConfig.imageConfig.aspectRatio' },
        { key: 'resolution', label: '清晰度', type: 'select', default: '1k', options: ['1k', '2k', '4k'].map((value) => ({ label: value.toUpperCase(), value })), bind: 'body.generationConfig.imageConfig.imageSize' },
      ],
    },
  },
  'apimart-claude': {
    id: 'apimart-claude',
    label: 'Claude Messages（异步平台）',
    summary: '异步聚合平台上的 Claude /v1/messages 格式，适合需要 Anthropic Messages 请求体的 Claude 模型。',
    kind: 'model-protocol-package',
    scope: 'model',
    auth: { type: 'bearer', header: 'Authorization', prefix: 'Bearer ' },
    headers: { 'anthropic-version': '2023-06-01' },
    unwrapData: true,
    models: { endpoint: '/v1/models', kind: 'openai' },
    capabilities: {
      llm: { endpoint: 'https://api.apimart.ai/v1/messages', body: 'anthropic_messages', parse: 'anthropic_text' },
      vlm: { endpoint: 'https://api.apimart.ai/v1/messages', body: 'anthropic_messages', parse: 'anthropic_text' },
    },
    operations: {
      'llm.chat': {
        label: 'APIMart Claude Messages',
        method: 'POST',
        path: 'https://api.apimart.ai/v1/messages',
        requestMode: 'json',
        bodyTemplate: {
          model: '{{model}}',
          messages: '{{messages}}',
          system: '{{params.system}}',
          max_tokens: '{{params.max_tokens}}',
        },
        response: { text: '$.content[0].text', usage: '$.usage' },
      },
      'llm.chat.vision': {
        label: 'APIMart Claude Vision',
        method: 'POST',
        path: 'https://api.apimart.ai/v1/messages',
        requestMode: 'json',
        bodyTemplate: {
          model: '{{model}}',
          messages: '{{messagesWithImages}}',
          max_tokens: '{{params.max_tokens}}',
        },
        response: { text: '$.content[0].text', usage: '$.usage' },
      },
    },
    modelProfiles: {
      claude: { label: 'Claude via APIMart', match: ['claude'], capabilities: ['llm.chat', 'llm.chat.vision', 'llm.tools'], uiSchemas: [] },
    },
    paramSchema: {
      llm: [
        { key: 'max_tokens', label: '最大输出', type: 'number', default: 1024, min: 1, max: 200000 },
      ],
    },
  },
  'apimart-media': {
    id: 'apimart-media',
    label: '媒体异步任务',
    summary: '图片、视频、音乐等提交任务后查询结果的异步生成协议，适合 VEO、Seedance、Kling、Suno 等模型。',
    kind: 'model-protocol-package',
    scope: 'model',
    auth: { type: 'bearer', header: 'Authorization', prefix: 'Bearer ' },
    unwrapData: true,
    models: { endpoint: '/v1/models', kind: 'openai' },
    capabilities: {
      image: { endpoint: '/v1/images/generations', body: 'openai_chat', parse: 'openai_chat' },
      video: { endpoint: '/v1/videos/generations', body: 'openai_chat', parse: 'openai_chat' },
      audio: { endpoint: '/v1/audio/speech', body: 'openai_chat', parse: 'openai_chat' },
    },
    operations: {
      'image.generate': {
        label: 'APIMart Gemini Image',
        method: 'POST',
        path: '/v1beta/models/{model}:generateContent',
        requestMode: 'json',
        derive: GEMINI_IMAGE_DERIVE,
        bodyTemplate: {
          contents: [{ role: 'user', parts: [{ text: '{{prompt}}' }] }],
          generationConfig: {
            responseModalities: ['TEXT', 'IMAGE'],
            imageConfig: {
              aspectRatio: '{{derived.aspectRatio}}',
              imageSize: '{{derived.imageSize}}',
            },
          },
        },
        response: { images: '$.candidates[*].content.parts[*].inlineData.data' },
        uiSchema: 'apimart-image-generate',
      },
      'video.generate': {
        label: 'APIMart Video Generations',
        method: 'POST',
        path: '/v1/videos/generations',
        requestMode: 'json',
        bodyTemplate: {
          model: '{{model}}',
          prompt: '{{prompt}}',
          duration: '{{params.duration}}',
          size: '{{params.size}}',
          resolution: '{{params.resolution}}',
          generate_audio: '{{params.generate_audio}}',
        },
        response: {
          taskId: '$.id || $.task_id || $.data.id || $.data.task_id',
          videos: '$..video_url || $..url',
        },
        uiSchema: 'apimart-video-generate',
      },
      'video.image_to_video': {
        label: 'APIMart Image To Video',
        method: 'POST',
        path: '/v1/videos/generations',
        requestMode: 'json',
        bodyTemplate: {
          model: '{{model}}',
          prompt: '{{prompt}}',
          image_urls: '{{inputs.imageUrls}}',
          duration: '{{params.duration}}',
          size: '{{params.size}}',
          resolution: '{{params.resolution}}',
          generate_audio: '{{params.generate_audio}}',
        },
        response: {
          taskId: '$.id || $.task_id || $.data.id || $.data.task_id',
          videos: '$..video_url || $..url',
        },
        uiSchema: 'apimart-video-generate',
      },
      'audio.music': {
        label: 'APIMart Music Generation',
        method: 'POST',
        path: '/v1/music/generations',
        requestMode: 'json',
        bodyTemplate: { model: '{{model}}', prompt: '{{prompt}}', title: '{{params.title}}', lyrics: '{{params.lyrics}}', style: '{{params.style}}', instrumental: '{{params.instrumental}}' },
        response: { taskId: '$.id || $.task_id || $.data.id || $.data.task_id', audios: '$..audio_url || $..url' },
        uiSchema: 'apimart-music-generate',
      },
      'tasks.get': {
        label: 'APIMart Task Query',
        method: 'GET',
        path: '/v1/tasks/{task_id}',
        requestMode: 'path',
        response: { task: '$', media: '$..url' },
      },
      'tasks.cancel': {
        label: 'APIMart Task Cancel',
        method: 'POST',
        path: '/v1/tasks/{task_id}/cancel',
        requestMode: 'path',
        response: { task: '$', status: '$.status || $.data.status' },
      },
      'uploads.image': {
        label: 'APIMart Image Upload',
        method: 'POST',
        path: '/v1/uploads/images',
        requestMode: 'multipart',
        bodyTemplate: { file: '{{inputs.file}}' },
        response: { url: '$.url || $.data.url || $.data.file_url || $.data.asset_url' },
        uiSchema: 'apimart-upload',
      },
      'uploads.video': {
        label: 'APIMart Video Upload',
        method: 'POST',
        path: '/v1/uploads/videos',
        requestMode: 'multipart',
        bodyTemplate: { file: '{{inputs.file}}' },
        response: { url: '$.url || $.data.url || $.data.file_url || $.data.asset_url' },
        uiSchema: 'apimart-upload',
      },
      'uploads.audio': {
        label: 'APIMart Audio Upload',
        method: 'POST',
        path: '/v1/uploads/audios',
        requestMode: 'multipart',
        bodyTemplate: { file: '{{inputs.file}}' },
        response: { url: '$.url || $.data.url || $.data.file_url || $.data.asset_url' },
        uiSchema: 'apimart-upload',
      },
      'uploads.file': {
        label: 'APIMart File Upload',
        method: 'POST',
        path: '/v1/uploads/files',
        requestMode: 'multipart',
        bodyTemplate: { file: '{{inputs.file}}' },
        response: { url: '$.url || $.data.url || $.data.file_url || $.data.asset_url' },
        uiSchema: 'apimart-upload',
      },
      'webhook.receive': {
        label: 'APIMart Webhook Callback',
        method: 'POST',
        path: '{{callback_url}}',
        requestMode: 'json',
        bodyTemplate: { task_id: '{{task_id}}', status: '{{status}}', result: '{{result}}', error: '{{error}}' },
        response: { taskId: '$.task_id || $.id', status: '$.status', result: '$.result || $.data' },
        uiSchema: 'apimart-webhook',
      },
    },
    modelProfiles: {
      'veo3.1-lite': { label: 'VEO 3.1 Lite via APIMart', capabilities: ['video.generate', 'video.text_to_video'], uiSchemas: ['apimart-video-generate'], operationPreference: ['video.generate'], limits: { ...APIMART_VEO_LIMITS, references: { images: { max: 0 }, videos: { max: 0 }, audios: { max: 0 } } } },
      veo: { label: 'VEO via APIMart', match: ['veo'], capabilities: ['video.generate', 'video.text_to_video', 'video.image_to_video', 'video.first_last_frame'], uiSchemas: ['apimart-video-generate'], operationPreference: ['video.generate', 'video.image_to_video'], limits: APIMART_VEO_LIMITS },
      'seedance-2.5': APIMART_SEEDANCE25_PROFILE,
      seedance: { label: 'Seedance via APIMart', match: ['doubao-seedance', 'seedance'], capabilities: ['video.generate', 'video.text_to_video', 'video.image_to_video', 'video.first_last_frame', 'video.multi_reference', 'video.video_to_video', 'video.audio_reference', 'video.multimodal'], uiSchemas: ['apimart-video-generate'], operationPreference: ['video.generate', 'video.image_to_video'], limits: APIMART_SEEDANCE_LIMITS },
      kling: { label: 'Kling via APIMart', match: ['kling', '可灵'], capabilities: ['video.generate', 'video.image_to_video'], uiSchemas: ['apimart-video-generate'], operationPreference: ['video.generate', 'video.image_to_video'] },
      suno: { label: 'Suno via APIMart', match: ['suno'], capabilities: ['audio.music'], uiSchemas: ['apimart-music-generate'], operationPreference: ['audio.music'] },
    },
    uiSchemas: {
      'apimart-image-generate': [
        { key: 'aspect_ratio', label: '比例', type: 'select', default: '1:1', options: ['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9', '21:9', '9:21'].map((value) => ({ label: value, value })), bind: 'body.generationConfig.imageConfig.aspectRatio' },
        { key: 'resolution', label: '清晰度', type: 'select', default: '1k', options: ['1k', '2k', '4k'].map((value) => ({ label: value.toUpperCase(), value })), bind: 'body.generationConfig.imageConfig.imageSize' },
      ],
      'apimart-video-generate': [
        { key: 'duration', label: '时长', type: 'select', default: 5, options: Array.from({ length: 12 }, (_, index) => index + 4).map((value) => ({ label: `${value}s`, value })), bind: 'body.duration' },
        { key: 'size', label: '比例', type: 'select', default: '16:9', options: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'adaptive'].map((value) => ({ label: value, value })), bind: 'body.size' },
        { key: 'resolution', label: '清晰度', type: 'select', default: '480p', options: ['480p', '720p', '1080p', '4k'].map((value) => ({ label: value.toUpperCase(), value })), bind: 'body.resolution' },
        { key: 'generate_audio', label: '生成音频', type: 'toggle', default: false, bind: 'body.generate_audio' },
      ],
      'apimart-music-generate': MUSIC_SCHEMA,
      'apimart-upload': [
        { key: 'purpose', label: '用途', type: 'select', default: 'reference', options: ['reference', 'input', 'mask', 'asset'].map((value) => ({ label: value, value })), bind: 'body.purpose' },
      ],
      'apimart-webhook': [
        { key: 'callback_url', label: '回调地址', type: 'text', default: '', bind: 'body.callback_url' },
        { key: 'secret', label: '签名密钥', type: 'text', default: '', bind: 'headers.x-webhook-secret' },
      ],
    },
  },
  'agtoken-video': {
    id: 'agtoken-video',
    label: 'AG 模型协议',
    summary: 'AGToken 视频模型协议；按模型自动选择 AG 统一接口、Seedance 火山兼容接口或 Wan DashScope 兼容接口。',
    kind: 'model-protocol-package',
    scope: 'model',
    categories: ['video', 'task', 'seedance', 'wan'],
    auth: { type: 'bearer', header: 'Authorization', prefix: 'Bearer ' },
    models: { endpoint: '/v1/models', kind: 'openai' },
    capabilities: {
      video: { endpoint: '/v1/video/generations', body: 'openai_chat', parse: 'openai_chat' },
    },
    operations: {
      'video.generate': {
        label: 'AG 视频生成', method: 'POST', path: '/v1/video/generations', requestMode: 'json',
        bodyTemplate: { model: '{{model}}', prompt: '{{prompt}}', duration: '{{params.duration}}', images: '{{inputs.images}}', metadata: '{{params.metadata}}' },
        response: { taskId: '$.task_id', videos: '$.data.result_url' }, uiSchema: 'agtoken-video',
      },
      'video.multimodal': {
        label: 'AG Seedance 多模态视频', method: 'POST', path: '/api/v3/contents/generations/tasks', requestMode: 'json',
        response: { taskId: '$.id', videos: '$.content.video_url' }, uiSchema: 'agtoken-video',
      },
      'tasks.get': { label: 'AG 视频任务查询', method: 'GET', path: '/v1/video/generations/{task_id}', requestMode: 'path' },
    },
    modelProfiles: {
      'seedance-2.0': {
        label: 'AG Seedance 2.0', match: ['doubao-seedance-2-0', 'doubao-seedance-2.0'],
        capabilities: ['video.generate', 'video.text_to_video', 'video.image_to_video', 'video.first_last_frame', 'video.multi_reference', 'video.video_to_video', 'video.audio_reference', 'video.multimodal'],
        uiSchemas: ['agtoken-video'], limits: APIMART_SEEDANCE_LIMITS,
      },
      'seedance-2.5': {
        label: 'AG Seedance 2.5', match: ['doubao-seedance-2-5', 'doubao-seedance-2.5'],
        capabilities: ['video.generate', 'video.text_to_video', 'video.image_to_video', 'video.first_last_frame', 'video.multi_reference', 'video.video_to_video', 'video.audio_reference', 'video.multimodal'],
        uiSchemas: ['agtoken-video'],
        limits: {
          duration: { min: 4, max: 30, step: 1, integer: true, default: 5 },
          resolution: { options: ['480p', '720p'], default: '720p' },
          aspect_ratio: { options: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive'], default: 'adaptive' },
          references: { images: { max: 30 }, videos: { max: 10 }, audios: { max: 10 }, total: { max: 50 } },
        },
      },
      'wan-3.0': {
        label: 'AG Wan 3.0', match: ['wan3.0-video'],
        capabilities: ['video.generate', 'video.text_to_video', 'video.image_to_video', 'video.first_last_frame', 'video.multi_reference', 'video.video_to_video', 'video.audio_reference', 'video.multimodal'],
        uiSchemas: ['agtoken-video'],
        limits: {
          duration: { min: -1, max: 30, step: 1, integer: true, default: 5 },
          resolution: { options: ['480p', '720p', '1080p'], default: '1080p' },
          aspect_ratio: { options: ['adaptive', '16:9', '4:3', '1:1', '3:4', '9:16'], default: 'adaptive' },
          references: { images: { max: 30 }, videos: { max: 10 }, audios: { max: 10 }, total: { max: 50 } },
        },
      },
    },
    uiSchemas: {
      'agtoken-video': [
        { key: 'duration', label: '时长', type: 'number', default: 5, min: -1, max: 30, step: 1, bind: 'body.duration' },
        { key: 'aspect_ratio', label: '比例', type: 'select', default: 'adaptive', options: ['adaptive', '16:9', '4:3', '1:1', '3:4', '9:16', '21:9'].map((value) => ({ label: value, value })), bind: 'body.ratio' },
        { key: 'resolution', label: '清晰度', type: 'select', default: '720p', options: ['480p', '720p', '1080p', '4k'].map((value) => ({ label: value.toUpperCase(), value })), bind: 'body.resolution' },
        { key: 'generate_audio', label: '生成音频', type: 'toggle', default: true, bind: 'body.generate_audio' },
        { key: 'watermark', label: '水印', type: 'toggle', default: false, bind: 'body.watermark' },
      ],
    },
    paramSchema: { video: VIDEO_SCHEMA },
    docs: [{ title: 'AGToken 视频 API', url: 'https://agtoken.vip/docs' }],
  },
  'zkki-model': {
    id: 'zkki-model', label: 'ZKKI 模型协议',
    summary: 'ZKKI 图片与异步视频模型协议；图片走 Seedream JSON 接口，视频按 input/parameters 创建、轮询并鉴权下载成品。',
    kind: 'model-protocol-package', scope: 'model', categories: ['image', 'video', 'task', 'seedream', 'seedance'],
    auth: { type: 'bearer', header: 'Authorization', prefix: 'Bearer ' },
    models: { endpoint: '/v1/models', kind: 'openai' },
    capabilities: {
      image: { endpoint: '/v1/images/generations', body: 'openai_chat', parse: 'openai_chat' },
      video: { endpoint: '/v1/videos', body: 'openai_chat', parse: 'openai_chat' },
    },
    operations: {
      'image.generate': { label: 'ZKKI 图片生成', method: 'POST', path: '/v1/images/generations', requestMode: 'json', uiSchema: 'zkki-image' },
      'image.edit': { label: 'ZKKI 参考图生成', method: 'POST', path: '/v1/images/generations', requestMode: 'json', uiSchema: 'zkki-image' },
      'video.generate': { label: 'ZKKI 视频生成', method: 'POST', path: '/v1/videos', requestMode: 'json', uiSchema: 'zkki-video' },
      'tasks.get': { label: 'ZKKI 视频任务查询', method: 'GET', path: '/v1/videos/{task_id}', requestMode: 'path' },
      'video.download': { label: 'ZKKI 视频成品下载', method: 'GET', path: '/v1/videos/{task_id}/content', requestMode: 'path' },
    },
    modelProfiles: {
      seedream: { label: 'ZKKI Seedream', match: ['seedream'], capabilities: ['image.generate', 'image.edit'], uiSchemas: ['zkki-image'] },
      'seedance-2.0-mini-hc': { label: 'ZKKI Seedance 2.0 Mini HC', match: ['dreamina-seedance-2-0-mini-hc'], capabilities: ['video.generate', 'video.text_to_video', 'video.image_to_video', 'video.multi_reference', 'video.video_to_video', 'video.audio_reference', 'video.multimodal'], uiSchemas: ['zkki-video'], limits: { duration: { min: 4, max: 30, step: 1, integer: true, default: 5 }, resolution: { options: ['480p', '720p'], default: '720p' }, aspect_ratio: { options: ['1:1', '16:9', '9:16'], default: '16:9' }, references: { images: { max: 9 }, videos: { max: 3 }, audios: { max: 3 } } } },
      'seedance-2.0': { label: 'ZKKI Seedance 2.0', match: ['dreamina-seedance-2-0'], capabilities: ['video.generate', 'video.text_to_video', 'video.image_to_video', 'video.multi_reference', 'video.video_to_video', 'video.audio_reference', 'video.multimodal'], uiSchemas: ['zkki-video'], limits: { duration: { min: 4, max: 30, step: 1, integer: true, default: 5 }, resolution: { options: ['480p', '720p', '1080p', '4k'], default: '720p' }, aspect_ratio: { options: ['1:1', '16:9', '9:16'], default: '16:9' }, references: { images: { max: 9 }, videos: { max: 3 }, audios: { max: 3 } } } },
      'seedance-2.5': { label: 'ZKKI Seedance 2.5', match: ['dreamina-seedance-2-5', 'seedance-2.5-global-standard-multi'], capabilities: ['video.generate', 'video.text_to_video', 'video.image_to_video', 'video.multi_reference', 'video.video_to_video', 'video.audio_reference', 'video.multimodal'], uiSchemas: ['zkki-video'], limits: { duration: { min: 4, max: 30, step: 1, integer: true, default: 5 }, resolution: { options: ['480p', '720p', '1080p', '2k', '4k', 'native1080p'], default: '720p' }, aspect_ratio: { options: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'], default: '16:9' }, references: { images: { max: 30 }, videos: { max: 10 }, audios: { max: 10 } } } },
      'global-multi': { label: 'ZKKI Global 多模态', match: ['global-standard-multi'], capabilities: ['video.generate', 'video.image_to_video', 'video.multi_reference', 'video.video_to_video', 'video.audio_reference', 'video.multimodal'], uiSchemas: ['zkki-video'] },
      'text-to-video': { label: 'ZKKI 纯文生视频', match: ['global-standard-t2v'], capabilities: ['video.generate', 'video.text_to_video'], uiSchemas: ['zkki-video'], limits: { duration: { min: 4, max: 30, step: 1, integer: true, default: 5 }, references: { images: { max: 0 }, videos: { max: 0 }, audios: { max: 0 } } } },
      'minimax-h3': { label: 'ZKKI MiniMax H3', match: ['minimax-h3-d'], capabilities: ['video.generate', 'video.text_to_video', 'video.image_to_video', 'video.multi_reference'], uiSchemas: ['zkki-video'], limits: { duration: { min: 4, max: 15, step: 1, integer: true, default: 5 }, resolution: { options: ['2K', '768P'], default: '768P' }, aspect_ratio: { options: ['adaptive', '16:9', '9:16', '1:1'], default: 'adaptive' }, references: { images: { max: 9 }, videos: { max: 0 }, audios: { max: 0 } }, features: { generate_audio: false, watermark: false } } },
      omni: { label: 'ZKKI Omni', match: ['omni', 'omni-fast'], capabilities: ['video.generate', 'video.text_to_video', 'video.image_to_video', 'video.multi_reference'], uiSchemas: ['zkki-video'] },
      'gpt-image-2': { label: 'ZKKI GPT Image 2', match: ['gpt-image-2'], capabilities: ['image.generate', 'image.edit'], uiSchemas: ['zkki-image'] },
    },
    uiSchemas: {
      'zkki-image': [
        { key: 'size', label: '清晰度', type: 'select', default: '2K', options: ['auto', '1K', '1.5K', '2K'].map((value) => ({ label: value, value })), bind: 'body.size' },
        { key: 'aspect_ratio', label: '比例', type: 'select', default: '1:1', options: ['1:1', '4:3', '3:4', '16:9', '9:16', '21:9'].map((value) => ({ label: value, value })), bind: 'body.aspect_ratio' },
        { key: 'quality', label: '质量档位', type: 'select', default: 'gt_236w', options: [{ label: '高质量', value: 'gt_236w' }, { label: '标准', value: 'le_236w' }], bind: 'body.quality' },
      ],
      'zkki-video': [
        { key: 'duration', label: '时长', type: 'number', default: 5, min: 4, max: 30, step: 1, bind: 'body.parameters.duration' },
        { key: 'aspect_ratio', label: '比例', type: 'select', default: '16:9', options: ['adaptive', '16:9', '4:3', '1:1', '3:4', '9:16', '21:9'].map((value) => ({ label: value, value })), bind: 'body.parameters.ratio' },
        { key: 'resolution', label: '清晰度', type: 'select', default: '720p', options: ['480p', '720p', '1080p', '2k', '4k', 'native1080p', 'native4k'].map((value) => ({ label: value.toUpperCase(), value })), bind: 'body.parameters.resolution' },
        { key: 'generate_audio', label: '生成音频', type: 'toggle', default: true, bind: 'body.parameters.generate_audio' },
        { key: 'watermark', label: '水印', type: 'toggle', default: false, bind: 'body.parameters.watermark' },
      ],
    },
    paramSchema: { image: IMAGE_SCHEMA, video: VIDEO_SCHEMA },
    docs: [{ title: 'ZKKI API', url: 'https://api.zkki.net' }],
  },
  midjourney: {
    id: 'midjourney',
    label: 'Midjourney 异步任务',
    summary: 'Midjourney 异步任务协议，支持文生图、图生图、Blend、放大、变体、重绘、平移、缩放和任务查询。',
    kind: 'model-protocol-package',
    scope: 'model',
    categories: ['image', 'task', 'upscale', 'variation'],
    auth: { type: 'bearer', header: 'Authorization', prefix: 'Bearer ' },
    unwrapData: true,
    models: { endpoint: '/v1/models', kind: 'openai' },
    capabilities: {
      image: { endpoint: '/v1/midjourney/generations', body: 'openai_chat', parse: 'openai_chat' },
    },
    operations: {
      'image.generate': {
        label: 'Midjourney Imagine',
        method: 'POST',
        path: '/v1/midjourney/generations',
        requestMode: 'json',
        bodyTemplate: { prompt: '{{prompt}}', size: '{{params.size}}', version: '{{params.version}}', speed: '{{params.speed}}', image_urls: '{{inputs.imageUrls}}' },
        response: { taskId: '$.id || $.task_id || $.data.id || $.data.task_id', images: '$..image_url || $..image_urls || $..url' },
        uiSchema: 'midjourney-generate',
      },
      'image.blend': {
        label: 'Midjourney Blend',
        method: 'POST',
        path: '/v1/midjourney/generations/blend',
        requestMode: 'json',
        bodyTemplate: { image_urls: '{{inputs.imageUrls}}', size: '{{params.size}}', speed: '{{params.speed}}' },
        response: { taskId: '$.id || $.task_id || $.data.id || $.data.task_id', images: '$..image_url || $..image_urls || $..url' },
        uiSchema: 'midjourney-generate',
      },
      'image.edit': {
        label: 'Midjourney Edit',
        method: 'POST',
        path: '/v1/midjourney/generations/edits',
        requestMode: 'json',
        bodyTemplate: { prompt: '{{prompt}}', image_urls: '{{inputs.imageUrls}}', size: '{{params.size}}', version: '{{params.version}}', speed: '{{params.speed}}' },
        response: { taskId: '$.id || $.task_id || $.data.id || $.data.task_id', images: '$..image_url || $..image_urls || $..url' },
        uiSchema: 'midjourney-generate',
      },
      'image.upscale': {
        label: 'Midjourney Upscale',
        method: 'POST',
        path: '/v1/midjourney/generations/upscale',
        requestMode: 'json',
        bodyTemplate: { task_id: '{{params.task_id}}', index: '{{params.index}}', speed: '{{params.speed}}', custom_id: '{{params.custom_id}}' },
        response: { taskId: '$.id || $.task_id || $.data.id || $.data.task_id', images: '$..image_url || $..image_urls || $..url' },
        uiSchema: 'midjourney-action',
      },
      'image.variation': {
        label: 'Midjourney Variation',
        method: 'POST',
        path: '/v1/midjourney/generations/variation',
        requestMode: 'json',
        bodyTemplate: { task_id: '{{params.task_id}}', index: '{{params.index}}', speed: '{{params.speed}}', custom_id: '{{params.custom_id}}' },
        response: { taskId: '$.id || $.task_id || $.data.id || $.data.task_id', images: '$..image_url || $..image_urls || $..url' },
        uiSchema: 'midjourney-action',
      },
      'image.reroll': {
        label: 'Midjourney Reroll',
        method: 'POST',
        path: '/v1/midjourney/generations/reroll',
        requestMode: 'json',
        bodyTemplate: { task_id: '{{params.task_id}}', speed: '{{params.speed}}', custom_id: '{{params.custom_id}}' },
        response: { taskId: '$.id || $.task_id || $.data.id || $.data.task_id', images: '$..image_url || $..image_urls || $..url' },
        uiSchema: 'midjourney-action',
      },
      'image.zoom': {
        label: 'Midjourney Zoom',
        method: 'POST',
        path: '/v1/midjourney/generations/zoom',
        requestMode: 'json',
        bodyTemplate: { task_id: '{{params.task_id}}', zoom_ratio: '{{params.zoom_ratio}}', speed: '{{params.speed}}', custom_id: '{{params.custom_id}}' },
        response: { taskId: '$.id || $.task_id || $.data.id || $.data.task_id', images: '$..image_url || $..image_urls || $..url' },
        uiSchema: 'midjourney-action',
      },
      'image.pan': {
        label: 'Midjourney Pan',
        method: 'POST',
        path: '/v1/midjourney/generations/pan',
        requestMode: 'json',
        bodyTemplate: { task_id: '{{params.task_id}}', direction: '{{params.direction}}', speed: '{{params.speed}}', custom_id: '{{params.custom_id}}' },
        response: { taskId: '$.id || $.task_id || $.data.id || $.data.task_id', images: '$..image_url || $..image_urls || $..url' },
        uiSchema: 'midjourney-action',
      },
      'image.inpaint': {
        label: 'Midjourney Inpaint',
        method: 'POST',
        path: '/v1/midjourney/generations/inpaint',
        requestMode: 'json',
        bodyTemplate: { task_id: '{{params.task_id}}', prompt: '{{prompt}}', mask_image: '{{inputs.maskImage}}', speed: '{{params.speed}}', custom_id: '{{params.custom_id}}' },
        response: { taskId: '$.id || $.task_id || $.data.id || $.data.task_id', images: '$..image_url || $..image_urls || $..url' },
        uiSchema: 'midjourney-action',
      },
      'tasks.get': {
        label: 'Midjourney Task Query',
        method: 'GET',
        path: '/v1/midjourney/{task_id}',
        requestMode: 'path',
        response: { task: '$', status: '$.status || $.data.status', images: '$..image_url || $..image_urls || $..url' },
      },
    },
    modelProfiles: {
      midjourney: {
        label: 'Midjourney',
        match: ['midjourney', 'mj'],
        capabilities: ['image.generate', 'image.edit', 'image.blend', 'image.upscale', 'image.variation', 'image.reroll', 'image.zoom', 'image.pan', 'image.inpaint'],
        uiSchemas: ['midjourney-generate', 'midjourney-action'],
        operationPreference: ['image.generate'],
      },
    },
    uiSchemas: {
      'midjourney-generate': [
        { key: 'size', label: '比例', type: 'select', default: '1:1', options: ['1:1', '4:3', '3:4', '16:9', '9:16'].map((value) => ({ label: value, value })), bind: 'body.size' },
        { key: 'version', label: '版本', type: 'text', default: '6.1', bind: 'body.version' },
        { key: 'speed', label: '速度', type: 'select', default: 'relax', options: ['relax', 'fast', 'turbo'].map((value) => ({ label: value, value })), bind: 'body.speed' },
      ],
      'midjourney-action': [
        { key: 'task_id', label: '任务 ID', type: 'text', default: '', bind: 'body.task_id' },
        { key: 'index', label: '序号', type: 'number', default: 1, min: 1, max: 4, bind: 'body.index' },
        { key: 'speed', label: '速度', type: 'select', default: 'relax', options: ['relax', 'fast', 'turbo'].map((value) => ({ label: value, value })), bind: 'body.speed' },
        { key: 'direction', label: '方向', type: 'select', default: '', options: ['', 'left', 'right', 'up', 'down'].map((value) => ({ label: value || '无', value })), bind: 'body.direction' },
        { key: 'zoom_ratio', label: '缩放', type: 'slider', default: 2, min: 1, max: 2, step: 0.1, bind: 'body.zoom_ratio' },
      ],
    },
    paramSchema: { image: IMAGE_SCHEMA },
    docs: [{ title: 'APIMart Midjourney', url: 'https://docs.apimart.ai/cn' }],
  },
  'v2-unified': {
    id: 'v2-unified',
    label: '统一任务协议',
    kind: 'provider-protocol-package',
    summary: '文档中的统一任务风格协议包，面向图片、视频、音乐等异步生成任务。',
    categories: ['image', 'video', 'audio', 'music', 'task'],
    auth: { type: 'bearer', header: 'Authorization', prefix: 'Bearer ' },
    models: { endpoint: '/v1/models', kind: 'openai' },
    capabilities: {
      image: { endpoint: '/v2/images/generations', body: 'openai_chat', parse: 'openai_chat' },
      video: { endpoint: '/v2/videos/generations', body: 'openai_chat', parse: 'openai_chat' },
      audio: { endpoint: '/v2/music/generations', body: 'openai_chat', parse: 'openai_chat' },
    },
    operations: {
      'image.generate': {
        label: 'Unified Image Generation',
        method: 'POST',
        path: '/v2/images/generations',
        requestMode: 'json',
        bodyTemplate: { model: '{{model}}', prompt: '{{prompt}}', size: '{{params.size}}', aspect_ratio: '{{params.aspect_ratio}}', seed: '{{params.seed}}' },
        response: { taskId: '$.id || $.task_id || $.data.id || $.data.task_id', images: '$..image_url || $..url' },
        uiSchema: 'unified-image',
      },
      'video.generate': {
        label: 'Unified Video Generation',
        method: 'POST',
        path: '/v2/videos/generations',
        requestMode: 'json',
        bodyTemplate: { model: '{{model}}', prompt: '{{prompt}}', duration: '{{params.duration}}', aspect_ratio: '{{params.aspect_ratio}}', resolution: '{{params.resolution}}', seed: '{{params.seed}}' },
        response: { taskId: '$.id || $.task_id || $.data.id || $.data.task_id', videos: '$..video_url || $..url' },
        uiSchema: 'unified-video',
      },
      'video.image_to_video': {
        label: 'Unified Image To Video',
        method: 'POST',
        path: '/v2/videos/generations',
        requestMode: 'json',
        bodyTemplate: { model: '{{model}}', prompt: '{{prompt}}', images: '{{inputs.images}}', duration: '{{params.duration}}', aspect_ratio: '{{params.aspect_ratio}}', resolution: '{{params.resolution}}' },
        response: { taskId: '$.id || $.task_id || $.data.id || $.data.task_id', videos: '$..video_url || $..url' },
        uiSchema: 'unified-video',
      },
      'audio.music': {
        label: 'Unified Music Generation',
        method: 'POST',
        path: '/v2/music/generations',
        requestMode: 'json',
        bodyTemplate: { model: '{{model}}', prompt: '{{prompt}}', title: '{{params.title}}', lyrics: '{{params.lyrics}}', style: '{{params.style}}', instrumental: '{{params.instrumental}}' },
        response: { taskId: '$.id || $.task_id || $.data.id || $.data.task_id', audios: '$..audio_url || $..url' },
        uiSchema: 'unified-music',
      },
    },
    uiSchemas: { 'unified-image': IMAGE_SCHEMA, 'unified-video': VIDEO_SCHEMA, 'unified-music': MUSIC_SCHEMA },
    paramSchema: { image: IMAGE_SCHEMA, video: VIDEO_SCHEMA, audio: MUSIC_SCHEMA },
    docs: [{ title: 'Unified Generations', url: 'https://gpt-best.apifox.cn/doc-6113929' }],
  },
  xai: {
    id: 'xai',
    label: 'Grok 官方 API',
    kind: 'provider-protocol-package',
    summary: 'Grok 官方 api.x.ai 协议：Grok 文本、Imagine 2.0 图片生成/JSON 编辑与 Imagine Video 1.5 异步视频。',
    categories: ['llm', 'vision', 'tools', 'responses', 'image', 'video'],
    auth: { type: 'bearer', header: 'Authorization', prefix: 'Bearer ' },
    models: { endpoint: '/v1/models', kind: 'openai' },
    stream: true,
    capabilities: {
      llm: { endpoint: '/v1/chat/completions', body: 'openai_chat', parse: 'openai_chat' },
      vlm: { endpoint: '/v1/chat/completions', body: 'openai_chat', parse: 'openai_chat' },
      image: { endpoint: '/v1/images/generations', body: 'openai_chat', parse: 'openai_chat' },
      video: { endpoint: '/v1/videos/generations', body: 'openai_chat', parse: 'openai_chat' },
    },
    operations: {
      'llm.chat': { label: 'xAI Chat Completions', method: 'POST', path: '/v1/chat/completions', requestMode: 'json', uiSchema: 'xai-chat' },
      'llm.chat.vision': { label: 'xAI Vision', method: 'POST', path: '/v1/chat/completions', requestMode: 'json', uiSchema: 'xai-chat' },
      'llm.tools': { label: 'xAI Tools', method: 'POST', path: '/v1/chat/completions', requestMode: 'json', uiSchema: 'xai-chat' },
      'llm.responses': { label: 'xAI Responses', method: 'POST', path: '/v1/responses', requestMode: 'json', uiSchema: 'xai-responses' },
      'image.generate': {
        label: 'xAI Image Generations', method: 'POST', path: '/v1/images/generations', requestMode: 'json',
        bodyTemplate: { model: '{{model}}', prompt: '{{prompt}}', n: '{{params.n}}', aspect_ratio: '{{params.aspect_ratio}}', resolution: '{{params.resolution}}', quality: '{{params.quality}}', response_format: '{{params.response_format}}' },
        response: { images: '$.data[*].url || $.data[*].b64_json' }, uiSchema: 'xai-image',
      },
      'image.edit': {
        label: 'xAI JSON Image Edits', method: 'POST', path: '/v1/images/edits', requestMode: 'json',
        bodyTemplate: { model: '{{model}}', prompt: '{{prompt}}', image: '{{params.image}}', images: '{{params.images}}', aspect_ratio: '{{params.aspect_ratio}}', resolution: '{{params.resolution}}', quality: '{{params.quality}}', response_format: '{{params.response_format}}' },
        response: { images: '$.data[*].url || $.data[*].b64_json' }, uiSchema: 'xai-image',
      },
      'video.generate': {
        label: 'xAI Video Generations', method: 'POST', path: '/v1/videos/generations', requestMode: 'json',
        bodyTemplate: { model: '{{model}}', prompt: '{{prompt}}', duration: '{{params.duration}}', aspect_ratio: '{{params.aspect_ratio}}', resolution: '{{params.resolution}}', generate_audio: '{{params.generate_audio}}', image: '{{params.image}}' },
        response: { taskId: '$.request_id', videos: '$.video.url' }, uiSchema: 'xai-video',
      },
      'video.image_to_video': {
        label: 'xAI Image To Video', method: 'POST', path: '/v1/videos/generations', requestMode: 'json',
        bodyTemplate: { model: '{{model}}', prompt: '{{prompt}}', duration: '{{params.duration}}', aspect_ratio: '{{params.aspect_ratio}}', resolution: '{{params.resolution}}', generate_audio: '{{params.generate_audio}}', image: '{{params.image}}' },
        response: { taskId: '$.request_id', videos: '$.video.url' }, uiSchema: 'xai-video',
      },
    },
    modelProfiles: {
      'grok-imagine-image-2.0': { label: 'Grok Imagine Image 2.0', match: ['grok-imagine-image-2.0'], capabilities: ['image.generate', 'image.edit'], uiSchemas: ['xai-image'] },
      'grok-imagine-video-1.5': { label: 'Grok Imagine Video 1.5', match: ['grok-imagine-video-1.5'], capabilities: ['video.generate', 'video.text_to_video', 'video.image_to_video'], uiSchemas: ['xai-video'], limits: { duration: { min: 1, max: 15, step: 1, integer: true, default: 8 }, aspect_ratio: { options: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'], default: '16:9' }, resolution: { options: ['480p', '720p', '1080p'], default: '480p' }, references: { images: { max: 1 } } } },
      grok: { label: 'Grok Text', match: ['grok-'], capabilities: ['llm.chat', 'llm.chat.vision', 'llm.tools', 'llm.responses'], uiSchemas: ['xai-chat', 'xai-responses'] },
    },
    uiSchemas: {
      'xai-chat': [
        { key: 'temperature', label: '温度', type: 'slider', default: 0.7, min: 0, max: 2, step: 0.1, bind: 'body.temperature' },
        { key: 'max_tokens', label: '最大输出', type: 'number', default: 4096, min: 1, max: 131072, bind: 'body.max_tokens' },
      ],
      'xai-responses': [{ key: 'max_output_tokens', label: '最大输出', type: 'number', default: 4096, min: 1, max: 131072, bind: 'body.max_output_tokens' }],
      'xai-image': [
        { key: 'aspect_ratio', label: '比例', type: 'select', default: 'auto', options: ['auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '2:1', '1:2', '19.5:9', '9:19.5', '20:9', '9:20', '21:9', '5:2'].map((value) => ({ label: value, value })), bind: 'body.aspect_ratio' },
        { key: 'resolution', label: '清晰度', type: 'select', default: '1k', options: ['1k', '2k'].map((value) => ({ label: value.toUpperCase(), value })), bind: 'body.resolution' },
        { key: 'quality', label: '质量', type: 'select', default: 'auto', options: ['auto', 'low', 'medium'].map((value) => ({ label: value, value })), bind: 'body.quality' },
        { key: 'n', label: '数量', type: 'number', default: 1, min: 1, max: 10, bind: 'body.n' },
      ],
      'xai-video': [
        { key: 'duration', label: '时长', type: 'number', default: 8, min: 1, max: 15, step: 1, bind: 'body.duration' },
        { key: 'aspect_ratio', label: '比例', type: 'select', default: '16:9', options: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'].map((value) => ({ label: value, value })), bind: 'body.aspect_ratio' },
        { key: 'resolution', label: '清晰度', type: 'select', default: '480p', options: ['480p', '720p', '1080p'].map((value) => ({ label: value.toUpperCase(), value })), bind: 'body.resolution' },
        { key: 'generate_audio', label: '生成音频', type: 'toggle', default: true, bind: 'body.generate_audio' },
      ],
    },
    paramSchema: { image: IMAGE_SCHEMA, video: VIDEO_SCHEMA },
    docs: [{ title: 'Grok API', url: 'https://docs.x.ai/' }],
  },
  grok: {
    id: 'grok',
    label: 'Grok 图像/视频',
    kind: 'provider-protocol-package',
    summary: 'Grok 专用图像与视频生成协议声明。',
    categories: ['image', 'video'],
    auth: { type: 'bearer', header: 'Authorization', prefix: 'Bearer ' },
    models: { endpoint: '/v1/models', kind: 'openai' },
    capabilities: {
      image: { endpoint: '/v1/images/generations', body: 'openai_chat', parse: 'openai_chat' },
      video: { endpoint: '/v2/videos/generations', body: 'openai_chat', parse: 'openai_chat' },
    },
    operations: {
      'image.generate': {
        label: 'Grok Image',
        method: 'POST',
        path: '/v1/images/generations',
        requestMode: 'json',
        bodyTemplate: { model: '{{model}}', prompt: '{{prompt}}', size: '{{params.size}}', aspect_ratio: '{{params.aspect_ratio}}' },
        response: { images: '$.data[*].url || $.data[*].b64_json || $..image_url || $..url' },
        uiSchema: 'grok-image',
      },
      'video.generate': {
        label: 'Grok Video',
        method: 'POST',
        path: '/v2/videos/generations',
        requestMode: 'json',
        bodyTemplate: { model: '{{model}}', prompt: '{{prompt}}', duration: '{{params.duration}}', aspect_ratio: '{{params.aspect_ratio}}' },
        response: { taskId: '$.id || $.task_id || $.data.id || $.data.task_id', videos: '$..video_url || $..url' },
        uiSchema: 'grok-video',
      },
    },
    modelProfiles: {
      grok: { label: 'Grok Media', match: ['grok'], capabilities: ['image.generate', 'video.generate'], uiSchemas: ['grok-image', 'grok-video'] },
    },
    uiSchemas: { 'grok-image': IMAGE_SCHEMA, 'grok-video': VIDEO_SCHEMA },
    paramSchema: { image: IMAGE_SCHEMA, video: VIDEO_SCHEMA },
    docs: [{ title: 'Grok', url: 'https://gpt-best.apifox.cn/doc-6113929' }],
  },
  grok2api: {
    id: 'grok2api',
    label: 'Grok2API 全模态',
    kind: 'provider-protocol-package',
    summary: 'Grok2API 网关协议：兼容 OpenAI 对话，并支持 Grok Web / Build / Console 的 JSON 图片编辑、/v1 异步视频和语音接口。',
    categories: ['llm', 'vision', 'tools', 'responses', 'image', 'video', 'audio'],
    auth: { type: 'bearer', header: 'Authorization', prefix: 'Bearer ' },
    models: { endpoint: '/v1/models', kind: 'openai' },
    stream: true,
    capabilities: {
      llm: { endpoint: '/v1/chat/completions', body: 'openai_chat', parse: 'openai_chat' },
      vlm: { endpoint: '/v1/chat/completions', body: 'openai_chat', parse: 'openai_chat' },
      image: { endpoint: '/v1/images/generations', body: 'openai_chat', parse: 'openai_chat' },
      video: { endpoint: '/v1/videos/generations', body: 'openai_chat', parse: 'openai_chat' },
    },
    operations: {
      'llm.chat': { label: 'Grok2API Chat Completions', method: 'POST', path: '/v1/chat/completions', requestMode: 'json', uiSchema: 'grok2api-chat' },
      'llm.chat.vision': { label: 'Grok2API Vision', method: 'POST', path: '/v1/chat/completions', requestMode: 'json', uiSchema: 'grok2api-chat' },
      'llm.tools': { label: 'Grok2API Tools', method: 'POST', path: '/v1/chat/completions', requestMode: 'json', uiSchema: 'grok2api-chat' },
      'llm.responses': { label: 'Grok2API Responses', method: 'POST', path: '/v1/responses', requestMode: 'json', uiSchema: 'grok2api-responses' },
      'image.generate': {
        label: 'Grok2API Image Generations', method: 'POST', path: '/v1/images/generations', requestMode: 'json',
        bodyTemplate: { model: '{{model}}', prompt: '{{prompt}}', n: '{{params.n}}', aspect_ratio: '{{params.aspect_ratio}}', resolution: '{{params.resolution}}', quality: '{{params.quality}}', response_format: '{{params.response_format}}' },
        response: { images: '$.data[*].url || $.data[*].b64_json' }, uiSchema: 'grok2api-image',
      },
      'image.edit': {
        label: 'Grok2API Image Edits', method: 'POST', path: '/v1/images/edits', requestMode: 'json',
        bodyTemplate: { model: '{{model}}', prompt: '{{prompt}}', image: '{{params.image}}', images: '{{params.images}}', n: '{{params.n}}', quality: '{{params.quality}}', response_format: '{{params.response_format}}' },
        response: { images: '$.data[*].url || $.data[*].b64_json' }, uiSchema: 'grok2api-image',
      },
      'video.generate': {
        label: 'Grok2API Video Generations', method: 'POST', path: '/v1/videos/generations', requestMode: 'json',
        bodyTemplate: { model: '{{model}}', prompt: '{{prompt}}', duration: '{{params.duration}}', aspect_ratio: '{{params.aspect_ratio}}', resolution: '{{params.resolution}}', image: '{{params.image}}', reference_images: '{{params.reference_images}}', reference_audios: '{{params.reference_audios}}' },
        response: { taskId: '$.request_id', videos: '$.video.url' }, uiSchema: 'grok2api-video',
      },
      'video.image_to_video': {
        label: 'Grok2API Image To Video', method: 'POST', path: '/v1/videos/generations', requestMode: 'json',
        bodyTemplate: { model: '{{model}}', prompt: '{{prompt}}', duration: '{{params.duration}}', aspect_ratio: '{{params.aspect_ratio}}', resolution: '{{params.resolution}}', image: '{{params.image}}', reference_images: '{{params.reference_images}}' },
        response: { taskId: '$.request_id', videos: '$.video.url' }, uiSchema: 'grok2api-video',
      },
      'video.edit': {
        label: 'Grok2API Video Edits', method: 'POST', path: '/v1/videos/edits', requestMode: 'json',
        bodyTemplate: { model: '{{model}}', prompt: '{{prompt}}', video: '{{params.video}}' },
        response: { taskId: '$.request_id' }, uiSchema: 'grok2api-video',
      },
      'audio.tts': { label: 'Grok2API OpenAI Speech', method: 'POST', path: '/v1/audio/speech', requestMode: 'json', response: { audio: 'binary', contentType: 'audio/*' }, uiSchema: 'grok2api-audio' },
      'audio.transcribe': { label: 'Grok2API Transcriptions', method: 'POST', path: '/v1/audio/transcriptions', requestMode: 'multipart', response: { text: '$.text' }, uiSchema: 'grok2api-transcribe' },
    },
    modelProfiles: {
      'grok-imagine-image': { label: 'Grok Image', match: ['grok-imagine-image'], capabilities: ['image.generate', 'image.edit'], uiSchemas: ['grok2api-image'] },
      'grok-imagine-video': {
        label: 'Grok Video', match: ['grok-imagine-video'], capabilities: ['video.generate', 'video.image_to_video', 'video.edit'], uiSchemas: ['grok2api-video'],
        limits: {
          duration: { min: 1, max: 15, step: 1, integer: true, default: 8 },
          aspect_ratio: { options: ['1:1', '2:3', '3:2', '16:9', '9:16'], default: '16:9' },
          resolution: { options: ['480p', '720p', '1080p'], default: '720p' },
          references: { images: { max: 8 }, videos: { max: 1 }, audios: { max: 3 } },
        },
      },
      'grok-voice': { label: 'Grok Voice', match: ['grok-voice'], capabilities: ['audio.tts'], uiSchemas: ['grok2api-audio'] },
      'grok-stt': { label: 'Grok STT', match: ['grok-stt'], capabilities: ['audio.transcribe'], uiSchemas: ['grok2api-transcribe'] },
      grok: { label: 'Grok Chat', match: ['grok-'], capabilities: ['llm.chat', 'llm.chat.vision', 'llm.tools', 'llm.responses'], uiSchemas: ['grok2api-chat', 'grok2api-responses'] },
    },
    uiSchemas: {
      'grok2api-chat': [
        { key: 'temperature', label: '温度', type: 'slider', default: 0.7, min: 0, max: 2, step: 0.1, bind: 'body.temperature' },
        { key: 'max_tokens', label: '最大输出', type: 'number', default: 2048, min: 1, max: 128000, bind: 'body.max_completion_tokens' },
      ],
      'grok2api-responses': [
        { key: 'instructions', label: '系统指令', type: 'textarea', default: '', bind: 'body.instructions' },
        { key: 'max_output_tokens', label: '最大输出', type: 'number', default: 2048, min: 1, max: 128000, bind: 'body.max_output_tokens' },
      ],
      'grok2api-image': [
        { key: 'aspect_ratio', label: '比例', type: 'select', default: '1:1', options: ['1:1', '2:3', '3:2', '16:9', '9:16'].map((value) => ({ label: value, value })), bind: 'body.aspect_ratio' },
        { key: 'resolution', label: '清晰度', type: 'select', default: '1k', options: ['1k', '2k'].map((value) => ({ label: value.toUpperCase(), value })), bind: 'body.resolution' },
        { key: 'n', label: '数量', type: 'number', default: 1, min: 1, max: 4, bind: 'body.n' },
        { key: 'response_format', label: '返回格式', type: 'select', default: 'url', options: [{ label: 'URL', value: 'url' }, { label: 'Base64', value: 'b64_json' }], bind: 'body.response_format' },
      ],
      'grok2api-video': VIDEO_SCHEMA,
      'grok2api-audio': [
        { key: 'voice', label: '声音', type: 'text', default: 'eve', bind: 'body.voice' },
        { key: 'response_format', label: '格式', type: 'select', default: 'mp3', options: ['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'].map((value) => ({ label: value.toUpperCase(), value })), bind: 'body.response_format' },
        { key: 'speed', label: '语速', type: 'slider', default: 1, min: 0.25, max: 4, step: 0.05, bind: 'body.speed' },
      ],
      'grok2api-transcribe': [
        { key: 'language', label: '语言', type: 'text', default: '', bind: 'form.language' },
        { key: 'response_format', label: '返回格式', type: 'select', default: 'json', options: ['json', 'verbose_json', 'text'].map((value) => ({ label: value, value })), bind: 'form.response_format' },
      ],
    },
    paramSchema: { image: IMAGE_SCHEMA, video: VIDEO_SCHEMA },
  },
  kling: {
    id: 'kling',
    label: 'Kling 可灵',
    kind: 'provider-protocol-package',
    summary: 'Kling / 可灵文生视频、图生视频协议声明。',
    categories: ['video'],
    auth: { type: 'bearer', header: 'Authorization', prefix: 'Bearer ' },
    models: { endpoint: '/v1/models', kind: 'openai' },
    capabilities: { video: { endpoint: '/v2/videos/generations', body: 'openai_chat', parse: 'openai_chat' } },
    operations: {
      'video.generate': {
        label: 'Kling Text To Video',
        method: 'POST',
        path: '/v2/videos/generations',
        requestMode: 'json',
        bodyTemplate: { model: '{{model}}', prompt: '{{prompt}}', duration: '{{params.duration}}', aspect_ratio: '{{params.aspect_ratio}}', resolution: '{{params.resolution}}' },
        response: { taskId: '$.id || $.task_id || $.data.id || $.data.task_id', videos: '$..video_url || $..url' },
        uiSchema: 'kling-video',
      },
      'video.image_to_video': {
        label: 'Kling Image To Video',
        method: 'POST',
        path: '/v2/videos/generations',
        requestMode: 'json',
        bodyTemplate: { model: '{{model}}', prompt: '{{prompt}}', image: '{{inputs.image}}', duration: '{{params.duration}}', aspect_ratio: '{{params.aspect_ratio}}' },
        response: { taskId: '$.id || $.task_id || $.data.id || $.data.task_id', videos: '$..video_url || $..url' },
        uiSchema: 'kling-video',
      },
    },
    modelProfiles: { kling: { label: 'Kling Video', match: ['kling', '可灵'], capabilities: ['video.generate', 'video.image_to_video'], uiSchemas: ['kling-video'] } },
    uiSchemas: { 'kling-video': VIDEO_SCHEMA },
    paramSchema: { video: VIDEO_SCHEMA },
    docs: [{ title: 'Kling', url: 'https://gpt-best.apifox.cn/doc-6113929' }],
  },
  pixverse: {
    id: 'pixverse',
    label: 'PixVerse',
    kind: 'provider-protocol-package',
    summary: 'PixVerse 文生视频与图生视频协议声明。',
    categories: ['video'],
    auth: { type: 'bearer', header: 'Authorization', prefix: 'Bearer ' },
    models: { endpoint: '/v1/models', kind: 'openai' },
    capabilities: { video: { endpoint: '/v2/videos/generations', body: 'openai_chat', parse: 'openai_chat' } },
    operations: {
      'video.generate': { label: 'PixVerse Text To Video', method: 'POST', path: '/v2/videos/generations', requestMode: 'json', bodyTemplate: { model: '{{model}}', prompt: '{{prompt}}', duration: '{{params.duration}}', aspect_ratio: '{{params.aspect_ratio}}', resolution: '{{params.resolution}}' }, response: { taskId: '$.id || $.task_id || $.data.id || $.data.task_id', videos: '$..video_url || $..url' }, uiSchema: 'pixverse-video' },
      'video.image_to_video': { label: 'PixVerse Image To Video', method: 'POST', path: '/v2/videos/generations', requestMode: 'json', bodyTemplate: { model: '{{model}}', prompt: '{{prompt}}', image: '{{inputs.image}}', duration: '{{params.duration}}' }, response: { taskId: '$.id || $.task_id || $.data.id || $.data.task_id', videos: '$..video_url || $..url' }, uiSchema: 'pixverse-video' },
    },
    modelProfiles: { pixverse: { label: 'PixVerse Video', match: ['pixverse'], capabilities: ['video.generate', 'video.image_to_video'], uiSchemas: ['pixverse-video'] } },
    uiSchemas: { 'pixverse-video': VIDEO_SCHEMA },
    paramSchema: { video: VIDEO_SCHEMA },
    docs: [{ title: 'PixVerse', url: 'https://gpt-best.apifox.cn/doc-6113929' }],
  },
  pika: {
    id: 'pika',
    label: 'Pika',
    kind: 'provider-protocol-package',
    summary: 'Pika 视频生成协议声明。',
    categories: ['video'],
    auth: { type: 'bearer', header: 'Authorization', prefix: 'Bearer ' },
    models: { endpoint: '/v1/models', kind: 'openai' },
    capabilities: { video: { endpoint: '/v2/videos/generations', body: 'openai_chat', parse: 'openai_chat' } },
    operations: {
      'video.generate': { label: 'Pika Text To Video', method: 'POST', path: '/v2/videos/generations', requestMode: 'json', bodyTemplate: { model: '{{model}}', prompt: '{{prompt}}', duration: '{{params.duration}}', aspect_ratio: '{{params.aspect_ratio}}' }, response: { taskId: '$.id || $.task_id || $.data.id || $.data.task_id', videos: '$..video_url || $..url' }, uiSchema: 'pika-video' },
      'video.image_to_video': { label: 'Pika Image To Video', method: 'POST', path: '/v2/videos/generations', requestMode: 'json', bodyTemplate: { model: '{{model}}', prompt: '{{prompt}}', image: '{{inputs.image}}', duration: '{{params.duration}}' }, response: { taskId: '$.id || $.task_id || $.data.id || $.data.task_id', videos: '$..video_url || $..url' }, uiSchema: 'pika-video' },
    },
    modelProfiles: { pika: { label: 'Pika Video', match: ['pika'], capabilities: ['video.generate', 'video.image_to_video'], uiSchemas: ['pika-video'] } },
    uiSchemas: { 'pika-video': VIDEO_SCHEMA },
    paramSchema: { video: VIDEO_SCHEMA },
    docs: [{ title: 'Pika', url: 'https://gpt-best.apifox.cn/doc-6113929' }],
  },
  vidu: {
    id: 'vidu',
    label: 'Vidu',
    kind: 'provider-protocol-package',
    summary: 'Vidu 视频生成协议声明。',
    categories: ['video'],
    auth: { type: 'bearer', header: 'Authorization', prefix: 'Bearer ' },
    models: { endpoint: '/v1/models', kind: 'openai' },
    capabilities: { video: { endpoint: '/v2/videos/generations', body: 'openai_chat', parse: 'openai_chat' } },
    operations: {
      'video.generate': { label: 'Vidu Text To Video', method: 'POST', path: '/v2/videos/generations', requestMode: 'json', bodyTemplate: { model: '{{model}}', prompt: '{{prompt}}', duration: '{{params.duration}}', aspect_ratio: '{{params.aspect_ratio}}', resolution: '{{params.resolution}}' }, response: { taskId: '$.id || $.task_id || $.data.id || $.data.task_id', videos: '$..video_url || $..url' }, uiSchema: 'vidu-video' },
      'video.image_to_video': { label: 'Vidu Image To Video', method: 'POST', path: '/v2/videos/generations', requestMode: 'json', bodyTemplate: { model: '{{model}}', prompt: '{{prompt}}', image: '{{inputs.image}}', duration: '{{params.duration}}' }, response: { taskId: '$.id || $.task_id || $.data.id || $.data.task_id', videos: '$..video_url || $..url' }, uiSchema: 'vidu-video' },
    },
    modelProfiles: { vidu: { label: 'Vidu Video', match: ['vidu'], capabilities: ['video.generate', 'video.image_to_video'], uiSchemas: ['vidu-video'] } },
    uiSchemas: { 'vidu-video': VIDEO_SCHEMA },
    paramSchema: { video: VIDEO_SCHEMA },
    docs: [{ title: 'Vidu', url: 'https://gpt-best.apifox.cn/doc-6113929' }],
  },
  wanxiang: {
    id: 'wanxiang',
    label: '通义万相 / Wan',
    kind: 'provider-protocol-package',
    summary: '通义万相 / Wan 图像与视频生成协议声明。',
    categories: ['image', 'video'],
    auth: { type: 'bearer', header: 'Authorization', prefix: 'Bearer ' },
    models: { endpoint: '/v1/models', kind: 'openai' },
    capabilities: {
      image: { endpoint: '/v2/images/generations', body: 'openai_chat', parse: 'openai_chat' },
      video: { endpoint: '/v2/videos/generations', body: 'openai_chat', parse: 'openai_chat' },
    },
    operations: {
      'image.generate': { label: 'Wan Image', method: 'POST', path: '/v2/images/generations', requestMode: 'json', bodyTemplate: { model: '{{model}}', prompt: '{{prompt}}', size: '{{params.size}}', aspect_ratio: '{{params.aspect_ratio}}' }, response: { taskId: '$.id || $.task_id || $.data.id || $.data.task_id', images: '$..image_url || $..url' }, uiSchema: 'wanxiang-image' },
      'video.generate': { label: 'Wan Video', method: 'POST', path: '/v2/videos/generations', requestMode: 'json', bodyTemplate: { model: '{{model}}', prompt: '{{prompt}}', duration: '{{params.duration}}', aspect_ratio: '{{params.aspect_ratio}}', resolution: '{{params.resolution}}' }, response: { taskId: '$.id || $.task_id || $.data.id || $.data.task_id', videos: '$..video_url || $..url' }, uiSchema: 'wanxiang-video' },
      'video.image_to_video': { label: 'Wan Image To Video', method: 'POST', path: '/v2/videos/generations', requestMode: 'json', bodyTemplate: { model: '{{model}}', prompt: '{{prompt}}', image: '{{inputs.image}}', duration: '{{params.duration}}' }, response: { taskId: '$.id || $.task_id || $.data.id || $.data.task_id', videos: '$..video_url || $..url' }, uiSchema: 'wanxiang-video' },
    },
    modelProfiles: { wan: { label: 'Wan / 万相', match: ['wan', 'wanx', '通义万相'], capabilities: ['image.generate', 'video.generate', 'video.image_to_video'], uiSchemas: ['wanxiang-image', 'wanxiang-video'] } },
    uiSchemas: { 'wanxiang-image': IMAGE_SCHEMA, 'wanxiang-video': VIDEO_SCHEMA },
    paramSchema: { image: IMAGE_SCHEMA, video: VIDEO_SCHEMA },
    docs: [{ title: 'Wanxiang', url: 'https://gpt-best.apifox.cn/doc-6113929' }],
  },
  minimax: {
    id: 'minimax',
    label: 'MiniMax / Hailuo',
    kind: 'provider-protocol-package',
    summary: 'MiniMax 官方 M3/M2 对话、image-01 图片、H3 视频与 Speech 语音协议。',
    categories: ['llm', 'vision', 'image', 'video', 'audio'],
    auth: { type: 'bearer', header: 'Authorization', prefix: 'Bearer ' },
    models: { endpoint: '/v1/models', kind: 'openai' },
    capabilities: {
      video: { endpoint: '/v2/video_generation', body: 'openai_chat', parse: 'openai_chat' },
      audio: { endpoint: '/v1/t2a_v2', body: 'openai_chat', parse: 'openai_chat' },
    },
    operations: {
      'video.generate': { label: 'MiniMax H3 视频生成', method: 'POST', path: '/v2/video_generation', requestMode: 'json', uiSchema: 'minimax-video' },
      'video.text_to_video': { label: 'MiniMax H3 文生视频', method: 'POST', path: '/v2/video_generation', requestMode: 'json', uiSchema: 'minimax-video' },
      'video.image_to_video': { label: 'MiniMax H3 图生视频', method: 'POST', path: '/v2/video_generation', requestMode: 'json', uiSchema: 'minimax-video' },
      'video.first_last_frame': { label: 'MiniMax H3 首尾帧', method: 'POST', path: '/v2/video_generation', requestMode: 'json', uiSchema: 'minimax-video' },
      'video.multi_reference': { label: 'MiniMax H3 多图参考', method: 'POST', path: '/v2/video_generation', requestMode: 'json', uiSchema: 'minimax-video' },
      'video.video_to_video': { label: 'MiniMax H3 视频参考', method: 'POST', path: '/v2/video_generation', requestMode: 'json', uiSchema: 'minimax-video' },
      'video.audio_reference': { label: 'MiniMax H3 音频参考', method: 'POST', path: '/v2/video_generation', requestMode: 'json', uiSchema: 'minimax-video' },
      'video.multimodal': { label: 'MiniMax H3 多模态参考', method: 'POST', path: '/v2/video_generation', requestMode: 'json', uiSchema: 'minimax-video' },
      'audio.tts': { label: 'MiniMax Speech', method: 'POST', path: '/v1/audio/speech', requestMode: 'json', bodyTemplate: { model: '{{model}}', input: '{{input}}', voice: '{{params.voice}}' }, response: { audio: 'binary' }, uiSchema: 'minimax-audio' },
    },
    modelProfiles: { minimax: { label: 'MiniMax H3 / Hailuo', match: ['minimax-h3', 'minimax', 'hailuo', '海螺'], capabilities: ['video.generate', 'video.text_to_video', 'video.image_to_video', 'video.first_last_frame', 'video.multi_reference', 'video.video_to_video', 'video.audio_reference', 'video.multimodal', 'audio.tts'], uiSchemas: ['minimax-video', 'minimax-audio'], limits: MINIMAX_H3_LIMITS } },
    uiSchemas: {
      'minimax-video': VIDEO_SCHEMA,
      'minimax-audio': [
        { key: 'voice', label: '声音', type: 'text', default: '', bind: 'body.voice' },
        { key: 'speed', label: '语速', type: 'slider', default: 1, min: 0.5, max: 2, step: 0.05, bind: 'body.speed' },
      ],
    },
    paramSchema: { video: VIDEO_SCHEMA, audio: MUSIC_SCHEMA },
    docs: [{ title: 'MiniMax 官方模型 API', url: 'https://platform.minimax.cn/docs/guides/models-intro' }],
  },
  suno: {
    id: 'suno',
    label: 'Suno 音乐',
    kind: 'provider-protocol-package',
    summary: 'Suno 音乐生成协议声明。',
    categories: ['audio', 'music'],
    auth: { type: 'bearer', header: 'Authorization', prefix: 'Bearer ' },
    models: { endpoint: '/v1/models', kind: 'openai' },
    capabilities: { audio: { endpoint: '/v2/music/generations', body: 'openai_chat', parse: 'openai_chat' } },
    operations: {
      'audio.music': { label: 'Suno Music', method: 'POST', path: '/v2/music/generations', requestMode: 'json', bodyTemplate: { model: '{{model}}', prompt: '{{prompt}}', title: '{{params.title}}', lyrics: '{{params.lyrics}}', style: '{{params.style}}', instrumental: '{{params.instrumental}}' }, response: { taskId: '$.id || $.task_id || $.data.id || $.data.task_id', audios: '$..audio_url || $..url' }, uiSchema: 'suno-music' },
    },
    modelProfiles: { suno: { label: 'Suno Music', match: ['suno'], capabilities: ['audio.music'], uiSchemas: ['suno-music'] } },
    uiSchemas: { 'suno-music': MUSIC_SCHEMA },
    paramSchema: { audio: MUSIC_SCHEMA },
    docs: [{ title: 'Suno', url: 'https://gpt-best.apifox.cn/doc-6113929' }],
  },
  agnes: {
    id: 'agnes',
    label: 'Agnes AI 原生协议',
    kind: 'provider-protocol-package',
    summary: 'Agnes OpenAI 兼容对话、JSON 图片生成/编辑和原生异步视频协议。',
    categories: ['llm', 'image', 'video', 'free'],
    auth: { type: 'bearer', header: 'Authorization', prefix: 'Bearer ' },
    models: { endpoint: '/v1/models', kind: 'openai' },
    stream: true,
    capabilities: {
      llm: { endpoint: '/v1/chat/completions', body: 'openai_chat', parse: 'openai_chat' },
      vlm: { endpoint: '/v1/chat/completions', body: 'openai_chat', parse: 'openai_chat' },
      image: { endpoint: '/v1/images/generations', body: 'openai_chat', parse: 'openai_chat' },
      video: { endpoint: '/v1/videos', body: 'openai_chat', parse: 'openai_chat' },
    },
    operations: {
      'llm.chat': { label: 'Agnes Chat', method: 'POST', path: '/v1/chat/completions', requestMode: 'json' },
      'llm.tools': { label: 'Agnes Tool Calling', method: 'POST', path: '/v1/chat/completions', requestMode: 'json' },
      'image.generate': { label: 'Agnes Image', method: 'POST', path: '/v1/images/generations', requestMode: 'json', uiSchema: 'agnes-image' },
      'image.edit': { label: 'Agnes Image Edit', method: 'POST', path: '/v1/images/generations', requestMode: 'json', uiSchema: 'agnes-image' },
      'video.generate': { label: 'Agnes Video', method: 'POST', path: '/v1/videos', requestMode: 'json', uiSchema: 'agnes-video' },
      'video.image_to_video': { label: 'Agnes Image to Video', method: 'POST', path: '/v1/videos', requestMode: 'json', uiSchema: 'agnes-video' },
      'video.first_last_frame': { label: 'Agnes 首尾帧', method: 'POST', path: '/v1/videos', requestMode: 'json', uiSchema: 'agnes-video' },
      'video.multi_reference': { label: 'Agnes 多图参考', method: 'POST', path: '/v1/videos', requestMode: 'json', uiSchema: 'agnes-video' },
      'video.video_to_video': { label: 'Agnes 视频参考', method: 'POST', path: '/v1/videos', requestMode: 'json', uiSchema: 'agnes-video' },
      'video.audio_reference': { label: 'Agnes 音频参考', method: 'POST', path: '/v1/videos', requestMode: 'json', uiSchema: 'agnes-video' },
      'video.multimodal': { label: 'Agnes 多模态参考', method: 'POST', path: '/v1/videos', requestMode: 'json', uiSchema: 'agnes-video' },
    },
    modelProfiles: {
      image: { label: 'Agnes Image', match: ['agnes-image-'], capabilities: ['image.generate', 'image.edit'], uiSchemas: ['agnes-image'] },
      'agnes-video-2.5-flash': {
        label: 'Agnes Video 2.5 Flash',
        match: ['agnes-video-2.5-flash', 'agnes-video-v2.5-flash'],
        capabilities: ['video.generate', 'video.text_to_video', 'video.image_to_video', 'video.first_last_frame', 'video.multi_reference', 'video.audio_reference', 'video.multimodal'],
        uiSchemas: ['agnes-video'],
        limits: {
          duration: { min: 4, max: 12, step: 1, integer: true, default: 5 },
          aspect_ratio: { options: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'], default: '16:9' },
          resolution: { options: ['720p'], default: '720p' },
          references: { images: { max: 5 }, videos: { max: 0 }, audios: { max: 3 } },
          features: { generate_audio: false, enhance_prompt: false, camera_fixed: false, watermark: false },
        },
      },
      'agnes-video-2.5': {
        label: 'Agnes Video 2.5', match: ['agnes-video-2.5', 'agnes-video-v2.5'],
        capabilities: ['video.generate', 'video.text_to_video', 'video.image_to_video', 'video.first_last_frame', 'video.multi_reference', 'video.video_to_video', 'video.audio_reference', 'video.multimodal'],
        uiSchemas: ['agnes-video'],
        limits: {
          duration: { min: 4, max: 12, step: 1, integer: true, default: 5 },
          aspect_ratio: { options: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'], default: '16:9' },
          resolution: { options: ['720p'], default: '720p' },
          references: { images: { max: 8 }, videos: { max: 1 }, audios: { max: 3 } },
          features: { generate_audio: false, enhance_prompt: false, camera_fixed: false, watermark: false },
        },
      },
      video: {
        label: 'Agnes Video',
        match: ['agnes-video-'],
        capabilities: ['video.generate', 'video.text_to_video', 'video.image_to_video', 'video.first_last_frame', 'video.multi_reference'],
        uiSchemas: ['agnes-video'],
        limits: {
          duration: { min: 1, max: 18, step: 1, integer: true, default: 5 },
          aspect_ratio: { options: ['16:9', '9:16', '4:3', '3:4', '1:1', '21:9', '9:21'], default: '16:9' },
          resolution: { options: ['480p', '720p', '1080p'], default: '720p' },
          references: { images: { max: 4 }, videos: { max: 0 }, audios: { max: 0 } },
          features: { generate_audio: false, enhance_prompt: false, camera_fixed: false, watermark: false },
        },
      },
    },
    uiSchemas: { 'agnes-image': AGNES_IMAGE_SCHEMA, 'agnes-video': VIDEO_SCHEMA },
    paramSchema: { image: AGNES_IMAGE_SCHEMA, video: VIDEO_SCHEMA },
    docs: [{ title: 'Agnes AI', url: 'https://platform.agnes-ai.com/settings/apiKeys' }],
  },
  modelscope: {
    id: 'modelscope',
    label: 'ModelScope 原生协议',
    kind: 'provider-protocol-package',
    summary: 'ModelScope OpenAI 兼容对话 + 异步图片任务协议，支持图片生成、图片编辑与模型专属 LoRA。',
    categories: ['llm', 'vision', 'image', 'lora'],
    auth: { type: 'bearer', header: 'Authorization', prefix: 'Bearer ' },
    models: { endpoint: '/v1/models', kind: 'openai' },
    stream: true,
    capabilities: {
      llm: { endpoint: '/v1/chat/completions', body: 'openai_chat', parse: 'openai_chat' },
      vlm: { endpoint: '/v1/chat/completions', body: 'openai_chat', parse: 'openai_chat' },
      image: { endpoint: '/v1/images/generations', body: 'openai_chat', parse: 'openai_chat' },
    },
    operations: {
      'llm.chat': { label: 'ModelScope Chat', method: 'POST', path: '/v1/chat/completions', requestMode: 'json' },
      'llm.tools': { label: 'ModelScope Tool Calling', method: 'POST', path: '/v1/chat/completions', requestMode: 'json' },
      'image.generate': { label: 'ModelScope 异步生图', method: 'POST', path: '/v1/images/generations', requestMode: 'json', uiSchema: 'modelscope-image' },
      'image.edit': { label: 'ModelScope 参考图生成', method: 'POST', path: '/v1/images/generations', requestMode: 'json', uiSchema: 'modelscope-image' },
    },
    modelProfiles: {
      image: { label: 'ModelScope Image', match: ['z-image', 'qwen-image', 'flux.2-klein'], capabilities: ['image.generate', 'image.edit'], uiSchemas: ['modelscope-image'] },
    },
    uiSchemas: { 'modelscope-image': MODELSCOPE_IMAGE_SCHEMA },
    paramSchema: { image: MODELSCOPE_IMAGE_SCHEMA },
    docs: [{ title: 'ModelScope', url: 'https://modelscope.cn/docs/model-service/API-Inference/intro' }],
  },
  volcengine: {
    id: 'volcengine',
    label: '火山引擎方舟',
    kind: 'provider-protocol-package',
    summary: '火山引擎方舟原生协议：OpenAI 兼容对话、Seedream 图片生成/编辑，以及 Seedance 异步视频任务。',
    categories: ['llm', 'vision', 'image', 'video', 'task', 'seedream', 'seedance'],
    auth: { type: 'bearer', header: 'Authorization', prefix: 'Bearer ' },
    models: { endpoint: '/api/v3/models', kind: 'openai' },
    stream: true,
    capabilities: {
      llm: { endpoint: '/api/v3/chat/completions', body: 'openai_chat', parse: 'openai_chat' },
      vlm: { endpoint: '/api/v3/chat/completions', body: 'openai_chat', parse: 'openai_chat' },
      image: { endpoint: '/api/v3/images/generations', body: 'openai_chat', parse: 'openai_chat' },
      video: { endpoint: '/api/v3/contents/generations/tasks', body: 'openai_chat', parse: 'openai_chat' },
    },
    operations: {
      'llm.chat': { label: '方舟兼容对话', method: 'POST', path: '/api/v3/chat/completions', requestMode: 'json' },
      'image.generate': { label: 'Seedream 文生图', method: 'POST', path: '/api/v3/images/generations', requestMode: 'json', uiSchema: 'volcengine-image' },
      'image.edit': { label: 'Seedream 参考图生成', method: 'POST', path: '/api/v3/images/generations', requestMode: 'json', uiSchema: 'volcengine-image' },
      'video.generate': { label: 'Seedance 视频任务', method: 'POST', path: '/api/v3/contents/generations/tasks', requestMode: 'json', uiSchema: 'volcengine-video' },
      'video.image_to_video': { label: 'Seedance 图生视频', method: 'POST', path: '/api/v3/contents/generations/tasks', requestMode: 'json', uiSchema: 'volcengine-video' },
      'video.first_last_frame': { label: 'Seedance 首尾帧', method: 'POST', path: '/api/v3/contents/generations/tasks', requestMode: 'json', uiSchema: 'volcengine-video' },
      'video.multi_reference': { label: 'Seedance 多模态参考', method: 'POST', path: '/api/v3/contents/generations/tasks', requestMode: 'json', uiSchema: 'volcengine-video' },
      'video.video_to_video': { label: 'Seedance 视频生视频', method: 'POST', path: '/api/v3/contents/generations/tasks', requestMode: 'json', uiSchema: 'volcengine-video' },
      'video.audio_reference': { label: 'Seedance 音频参考', method: 'POST', path: '/api/v3/contents/generations/tasks', requestMode: 'json', uiSchema: 'volcengine-video' },
      'video.multimodal': { label: 'Seedance 多模态参考', method: 'POST', path: '/api/v3/contents/generations/tasks', requestMode: 'json', uiSchema: 'volcengine-video' },
    },
    modelProfiles: {
      seedream: { label: '豆包 Seedream', match: ['seedream', 'doubao-seedream'], capabilities: ['image.generate', 'image.edit'], uiSchemas: ['volcengine-image'] },
      seedance: { label: '豆包 Seedance', match: ['seedance', 'doubao-seedance'], capabilities: ['video.generate', 'video.image_to_video', 'video.first_last_frame', 'video.multi_reference', 'video.video_to_video', 'video.audio_reference', 'video.multimodal'], uiSchemas: ['volcengine-video'], limits: VOLCENGINE_SEEDANCE_LIMITS },
    },
    uiSchemas: { 'volcengine-image': VOLCENGINE_IMAGE_SCHEMA, 'volcengine-video': VOLCENGINE_VIDEO_SCHEMA },
    paramSchema: { image: VOLCENGINE_IMAGE_SCHEMA, video: VOLCENGINE_VIDEO_SCHEMA },
    docs: [{ title: '火山方舟 API', url: 'https://www.volcengine.com/docs/82379' }],
  },
  'volcengine-speech': {
    id: 'volcengine-speech', label: '豆包语音', kind: 'provider-protocol-package',
    summary: '豆包语音独立 HTTP 协议：X-Api-Key 鉴权，支持语音合成 2.0、声音复刻 2.0 和 Seed Audio 1.0。',
    categories: ['audio', 'tts', 'speech'], auth: { type: 'api_key_header', header: 'X-Api-Key' }, models: { endpoint: '/api/v3/models', kind: 'openai' },
    capabilities: { audio: { endpoint: '/api/v3/tts/unidirectional', body: 'openai_chat', parse: 'openai_chat' } },
    operations: {
      'audio.tts': { label: '豆包同步语音合成', method: 'POST', path: '/api/v3/tts/unidirectional', requestMode: 'json', uiSchema: 'volcengine-speech' },
      'audio.music': { label: 'Seed Audio 音频生成', method: 'POST', path: '/api/v3/tts/create', requestMode: 'json', uiSchema: 'volcengine-audio-generate' },
    },
    modelProfiles: {
      'seed-tts-2.0': { label: '豆包语音合成 2.0', capabilities: ['audio.tts'], uiSchemas: ['volcengine-speech'] },
      'seed-icl-2.0': { label: '豆包声音复刻 2.0', capabilities: ['audio.tts'], uiSchemas: ['volcengine-speech'] },
      'seed-audio-1.0': { label: '豆包音频生成 1.0', capabilities: ['audio.music'], uiSchemas: ['volcengine-audio-generate'] },
    },
    uiSchemas: { 'volcengine-speech': VOLCENGINE_SPEECH_SCHEMA, 'volcengine-audio-generate': VOLCENGINE_SPEECH_SCHEMA },
    paramSchema: { audio: VOLCENGINE_SPEECH_SCHEMA },
    docs: [
      { title: '豆包语音合成 HTTP', url: 'https://docs.volcengine.com/docs/6561/2528925' },
      { title: 'Seed Audio HTTP', url: 'https://docs.volcengine.com/docs/6561/2550782' },
    ],
  },
  runninghub: {
    id: 'runninghub',
    label: 'RunningHub 全能力',
    kind: 'provider-protocol-package',
    summary: 'RunningHub 原生协议包：LLM、标准图像/视频模型、AI 应用与 OpenAPI 工作流。标准模型使用账户余额 Key，AI 应用和工作流可使用 RH币 Key。',
    categories: ['llm', 'vision', 'image', 'video', 'workflow', 'ai-app'],
    auth: { type: 'bearer', header: 'Authorization', prefix: 'Bearer ' },
    models: { endpoint: '/openapi/v2/models', kind: 'openai' },
    capabilities: {
      llm: { endpoint: 'https://llm.runninghub.ai/v1/chat/completions', body: 'openai_chat', parse: 'openai_chat' },
      vlm: { endpoint: 'https://llm.runninghub.ai/v1/chat/completions', body: 'openai_chat', parse: 'openai_chat' },
      image: { endpoint: '/openapi/v2/{model}', body: 'openai_chat', parse: 'openai_chat' },
      video: { endpoint: '/openapi/v2/{model}', body: 'openai_chat', parse: 'openai_chat' },
    },
    operations: {
      'llm.chat': { label: 'RunningHub LLM', method: 'POST', path: 'https://llm.runninghub.ai/v1/chat/completions', requestMode: 'json' },
      'image.generate': { label: 'RunningHub Image', method: 'POST', path: '/openapi/v2/{model}', requestMode: 'json' },
      'image.edit': { label: 'RunningHub Image Edit', method: 'POST', path: '/openapi/v2/{model}', requestMode: 'json' },
      'video.generate': { label: 'RunningHub Video', method: 'POST', path: '/openapi/v2/{model}', requestMode: 'json' },
      'workflow.run': { label: 'RunningHub Workflow', method: 'POST', path: '/task/openapi/create', requestMode: 'json' },
      'ai-app.run': { label: 'RunningHub AI App', method: 'POST', path: '/task/openapi/ai-app/run', requestMode: 'json' },
    },
    modelProfiles: {
      'image-edit-channel': {
        label: 'RunningHub 参考图编辑',
        match: ['gpt-image-2.0/edit', 'gpt-image-2/edit', 'nano-banana/edit', 'rhart-image-g-2/image-to-image', 'rhart-image-v1/edit'],
        capabilities: ['image.edit'],
        operationPreference: ['image.edit'],
      },
      'image-generate-channel': {
        label: 'RunningHub 文生图',
        match: ['gpt-image-2.0/text-to-image', 'gpt-image-2/text-to-image', 'nano-banana/text-to-image', 'rhart-image-g-2/text-to-image', 'rhart-image-v1/text-to-image'],
        capabilities: ['image.generate'],
        operationPreference: ['image.generate'],
      },
    },
    paramSchema: { image: IMAGE_SCHEMA, video: VIDEO_SCHEMA },
    docs: [{ title: 'RunningHub OpenAPI', url: 'https://www.runninghub.ai/openapi' }],
  },
};
const PROVIDER_PROTOCOLS = {
  ollama: {
    id: 'ollama',
    label: 'Ollama（本地）',
    summary: '连接本机或局域网 Ollama，自动读取已安装模型，无需 API Key。',
    kind: 'provider-protocol',
    categories: ['local', 'openai-compatible', 'llm', 'vision'],
    runtimeProtocol: 'ollama',
    auth: { type: 'none' },
    models: PROTOCOLS.ollama.models,
    stream: true,
    docs: PROTOCOLS.ollama.docs,
  },
  'cli:pippit': {
    id: 'cli:pippit',
    label: '小云雀 CLI',
    summary: '内置官方 pippit-tool-cli，支持网页登录、积分查询、图片/视频生成、多媒体参考和可恢复任务续查。',
    kind: 'provider-protocol',
    categories: ['cli', 'image', 'video', 'multimodal', 'task'],
    runtimeProtocol: 'cli:pippit',
    executor: { type: 'native', adapter: 'pippit-cli' },
    auth: { type: 'none' },
    models: { endpoint: '/api/cli/pippit/models', kind: 'openai' },
    operations: {
      'image.generate': { label: '小云雀生图', method: 'POST', path: '/api/ai/tasks', requestMode: 'json' },
      'image.edit': { label: '小云雀参考图生图', method: 'POST', path: '/api/ai/tasks', requestMode: 'json' },
      'video.generate': { label: '小云雀视频生成', method: 'POST', path: '/api/ai/tasks', requestMode: 'json', uiSchema: 'pippit-video' },
      'video.text_to_video': { label: '小云雀文生视频', method: 'POST', path: '/api/ai/tasks', requestMode: 'json', uiSchema: 'pippit-video' },
      'video.image_to_video': { label: '小云雀图生视频', method: 'POST', path: '/api/ai/tasks', requestMode: 'json', uiSchema: 'pippit-video' },
      'video.first_last_frame': { label: '小云雀首尾帧视频', method: 'POST', path: '/api/ai/tasks', requestMode: 'json', uiSchema: 'pippit-video' },
      'video.multimodal': { label: '小云雀多模态参考视频', method: 'POST', path: '/api/ai/tasks', requestMode: 'json', uiSchema: 'pippit-video' },
      'video.upscale': { label: '小云雀视频超分', method: 'POST', path: '/api/ai/tasks', requestMode: 'json', uiSchema: 'pippit-video-upscale' },
      'video.erase_subtitle': { label: '小云雀擦除字幕', method: 'POST', path: '/api/ai/tasks', requestMode: 'json', uiSchema: 'pippit-video-erase-subtitle' },
      'task.query': { label: '续查小云雀任务', method: 'POST', path: '/api/ai/tasks/:id/query', requestMode: 'json' },
    },
    uiSchemas: { 'pippit-video': PIPPIT_VIDEO_SCHEMA, 'pippit-video-upscale': PIPPIT_VIDEO_UPSCALE_SCHEMA, 'pippit-video-erase-subtitle': [] },
    paramSchema: { video: PIPPIT_VIDEO_SCHEMA },
    modelProfiles: {
      'pippit-seedream-5-pro': {
        label: '小云雀 Seedream 5.0 Pro',
        match: ['seedream_5.0_pro'],
        capabilities: ['image.generate', 'image.edit'],
        operationPreference: ['image.generate', 'image.edit'],
        limits: { resolution: { supported: true, options: ['1K', '2K', '4K'], default: '1K' }, references: { images: { max: 9 }, videos: { max: 0 }, audios: { max: 0 } } },
      },
      'pippit-image': {
        label: '小云雀图片模型',
        match: ['seedream_', 'nova2'],
        capabilities: ['image.generate', 'image.edit'],
        operationPreference: ['image.generate', 'image.edit'],
        limits: { resolution: { supported: false }, references: { images: { max: 9 }, videos: { max: 0 }, audios: { max: 0 } } },
      },
      'pippit-video': {
        label: '小云雀视频模型',
        match: ['Seedance_', 'seedance'],
        capabilities: ['video.generate', 'video.text_to_video', 'video.image_to_video', 'video.first_last_frame', 'video.multimodal', 'video.upscale', 'video.erase_subtitle'],
        uiSchemas: ['pippit-video'],
        operationPreference: ['video.generate'],
        limits: {
          references: { images: { max: 9 }, videos: { max: 3 }, audios: { max: 3 } },
          duration: { min: 1, max: 30, step: 1, integer: true, default: 5 }, resolution: { options: ['720p', '1080p'], default: '720p' }, aspect_ratio: { options: ASPECT_OPTIONS, default: '16:9' },
          byCapability: {
            'video.upscale': { references: { images: { max: 0 }, videos: { min: 1, max: 1 }, audios: { max: 0 } }, output_resolution: { options: ['720p', '1080p', '2k', '4k'], default: '1080p' }, tool_version: { options: ['standard', 'professional_v1', 'professional_v2'], default: 'standard' } },
            'video.erase_subtitle': { references: { images: { max: 0 }, videos: { min: 1, max: 1 }, audios: { max: 0 } } },
          },
        },
      },
    },
    docs: [{ title: 'Pippit CLI', url: 'https://github.com/Pippit-dev/cli' }],
  },
  'cli:dreamina-canvas': {
    id: 'cli:dreamina-canvas', label: 'Dreamina 海外 CLI', kind: 'provider-protocol',
    summary: '独立的 Dreamina Canvas CLI：实时模型、海外登录、图片与视频任务和积分确认。',
    categories: ['cli', 'image', 'video', 'task'], runtimeProtocol: 'cli:dreamina-canvas',
    executor: { type: 'native', adapter: 'dreamina-canvas-cli' }, auth: { type: 'none' },
    models: { endpoint: '/api/providers/models', kind: 'openai' },
    operations: {},
    modelProfiles: { default: { label: 'Dreamina Canvas 模型', match: [''], capabilities: ['image.generate', 'image.edit', 'video.generate', 'video.text_to_video', 'video.image_to_video', 'video.first_last_frame', 'video.multi_reference'] } },
  },
  'cli:jimeng': {
    id: 'cli:jimeng',
    label: '即梦 CLI',
    summary: '本地 dreamina CLI 完整协议：登录态、积分、模型、文生图、图生图、图片放大、文生视频、图生视频、首尾帧、多帧、全能参考和排队续查。',
    kind: 'provider-protocol',
    categories: ['cli', 'image', 'video', 'multimodal', 'task'],
    runtimeProtocol: 'cli:jimeng',
    executor: { type: 'native', adapter: 'jimeng-cli' },
    auth: { type: 'none' },
    models: { endpoint: '/api/cli/jimeng/models', kind: 'openai' },
    operations: {
      'image.generate': { label: '即梦文生图', method: 'POST', path: '/api/cli/jimeng/generate-image', requestMode: 'multipart' },
      'image.edit': { label: '即梦图生图', method: 'POST', path: '/api/cli/jimeng/generate-image', requestMode: 'multipart' },
      'image.upscale': { label: '即梦图片放大', method: 'POST', path: '/api/cli/jimeng/upscale-image', requestMode: 'multipart' },
      'video.generate': { label: '自动选择视频生成方式', description: '兼容入口，根据传入的图片、视频、音频和素材角色自动选择生成方式。', method: 'POST', path: '/api/cli/jimeng/generate-video', requestMode: 'multipart', uiSchema: 'jimeng-video' },
      'video.text_to_video': { label: '文生视频', description: '只使用提示词生成视频。', method: 'POST', path: '/api/cli/jimeng/generate-video', requestMode: 'multipart', uiSchema: 'jimeng-video' },
      'video.image_to_video': { label: '单图生视频', description: '使用一张起始图片生成视频。', method: 'POST', path: '/api/cli/jimeng/generate-video', requestMode: 'multipart', uiSchema: 'jimeng-video' },
      'video.first_last_frame': { label: '首尾帧生视频', description: '使用明确标记的首帧和尾帧生成过渡视频。', method: 'POST', path: '/api/cli/jimeng/generate-video', requestMode: 'multipart', uiSchema: 'jimeng-video' },
      'video.multi_reference': { label: '多图参考生视频', description: '使用多张参考图片生成连续镜头或多帧过渡。', method: 'POST', path: '/api/cli/jimeng/generate-video', requestMode: 'multipart', uiSchema: 'jimeng-video' },
      'video.video_to_video': { label: '参考视频生成', description: '使用参考视频控制动作、镜头或节奏。', method: 'POST', path: '/api/cli/jimeng/generate-video', requestMode: 'multipart', uiSchema: 'jimeng-video' },
      'video.audio_reference': { label: '参考音频生成', description: '把音频作为多模态参考素材参与视频生成。', method: 'POST', path: '/api/cli/jimeng/generate-video', requestMode: 'multipart', uiSchema: 'jimeng-video' },
      'video.multimodal': { label: '全能参考生成', description: '同时理解图片、视频和音频参考素材。', method: 'POST', path: '/api/cli/jimeng/generate-video', requestMode: 'multipart', uiSchema: 'jimeng-video' },
      'task.query': { label: '续查生成任务', method: 'POST', path: '/api/cli/jimeng/query-media', requestMode: 'json' },
      'task.list': { label: '任务列表', method: 'GET', path: '/api/cli/jimeng/tasks', requestMode: 'json' },
    },
    uiSchemas: { 'jimeng-video': VIDEO_SCHEMA },
    paramSchema: { video: VIDEO_SCHEMA },
    modelProfiles: {
      'jimeng-image-3': {
        label: '即梦图片 3.x',
        match: ['jimeng-3.0', 'jimeng-3.1'],
        capabilities: ['image.generate'],
        operationPreference: ['image.generate'],
        limits: {
          references: { images: { max: 0 }, videos: { max: 0 }, audios: { max: 0 } },
          features: JIMENG_IMAGE_FEATURES,
        },
      },
      'jimeng-image-modern': {
        label: '即梦图片 4.x/5.x',
        match: ['jimeng-4.', 'jimeng-5.'],
        capabilities: ['image.generate', 'image.edit'],
        operationPreference: ['image.generate', 'image.edit'],
        limits: {
          references: { images: { max: 10 }, videos: { max: 0 }, audios: { max: 0 } },
          features: JIMENG_IMAGE_FEATURES,
          byCapability: {
            'image.generate': { references: { images: { max: 0 } } },
            'image.edit': { references: { images: { min: 1, max: 10 } }, features: { outputAspectRatio: 'input' } },
          },
        },
      },
      'seedance1.0fast': {
        label: 'Seedance 1.0 Fast',
        capabilities: ['video.generate', 'video.image_to_video', 'video.multi_reference'],
        uiSchemas: ['jimeng-video'],
        operationPreference: ['video.image_to_video'],
        limits: {
          ...JIMENG_BASE_VIDEO_LIMITS,
          duration: { min: 5, max: 10, step: 1, integer: true, default: 5 },
          references: { images: { min: 1, max: 20 }, videos: { max: 0 }, audios: { max: 0 } },
          byCapability: {
            'video.image_to_video': { features: { outputAspectRatio: 'input' } },
            'video.multi_reference': { resolution: { options: ['720p', '1080p'], default: '720p' }, references: { images: { min: 2, max: 20 } }, features: { outputAspectRatio: 'input' } },
          },
        },
      },
      'seedance1.5pro': {
        label: 'Seedance 1.5 Pro',
        capabilities: ['video.generate', 'video.image_to_video', 'video.first_last_frame', 'video.multi_reference'],
        uiSchemas: ['jimeng-video'],
        operationPreference: ['video.image_to_video'],
        limits: {
          ...JIMENG_BASE_VIDEO_LIMITS,
          duration: { min: 5, max: 12, step: 1, integer: true, default: 5 },
          references: { images: { min: 1, max: 20 }, videos: { max: 0 }, audios: { max: 0 } },
          byCapability: {
            'video.image_to_video': { features: { outputAspectRatio: 'input' } },
            'video.first_last_frame': { references: { images: { min: 2, max: 2 } }, features: { outputAspectRatio: 'input' } },
            'video.multi_reference': { resolution: { options: ['720p', '1080p'], default: '720p' }, references: { images: { min: 2, max: 20 } }, features: { outputAspectRatio: 'input' } },
          },
        },
      },
      'seedance2.5': {
        label: 'Seedance 2.5',
        capabilities: ['video.generate', 'video.text_to_video', 'video.image_to_video', 'video.first_last_frame', 'video.multi_reference', 'video.video_to_video', 'video.audio_reference', 'video.multimodal'],
        uiSchemas: ['jimeng-video'],
        limits: JIMENG_SEEDANCE25_LIMITS,
      },
      'seedance2.0': {
        label: 'Seedance 2.0',
        capabilities: ['video.generate', 'video.text_to_video', 'video.image_to_video', 'video.first_last_frame', 'video.multi_reference', 'video.video_to_video', 'video.audio_reference', 'video.multimodal'],
        uiSchemas: ['jimeng-video'],
        limits: JIMENG_SEEDANCE2_LIMITS,
      },
      'seedance2.0_vip': {
        label: 'Seedance 2.0 VIP',
        capabilities: ['video.generate', 'video.text_to_video', 'video.image_to_video', 'video.first_last_frame', 'video.multi_reference', 'video.video_to_video', 'video.audio_reference', 'video.multimodal'],
        uiSchemas: ['jimeng-video'],
        limits: {
          ...JIMENG_SEEDANCE2_LIMITS,
          resolution: { options: ['720p', '1080p', '4k'], default: '720p' },
        },
      },
      'seedance2.0fast': {
        label: 'Seedance 2.0 Fast', match: ['seedance2.0fast', 'seedance2.0fast_vip'],
        capabilities: ['video.generate', 'video.text_to_video', 'video.image_to_video', 'video.first_last_frame', 'video.multi_reference', 'video.video_to_video', 'video.audio_reference', 'video.multimodal'],
        uiSchemas: ['jimeng-video'], limits: JIMENG_SEEDANCE2_LIMITS,
      },
      'seedance2.0mini': {
        label: 'Seedance 2.0 Mini',
        capabilities: ['video.generate', 'video.text_to_video', 'video.image_to_video', 'video.first_last_frame', 'video.multi_reference', 'video.video_to_video', 'video.audio_reference', 'video.multimodal'],
        uiSchemas: ['jimeng-video'], limits: JIMENG_SEEDANCE2_LIMITS,
      },
    },
    docs: [{ title: '本地 dreamina CLI', url: '/api/cli/jimeng/help' }],
  },
  'cli:codex': {
    id: 'cli:codex', label: 'GPT CLI', summary: '复用本机 OpenAI Codex 登录态进行对话，并通过 GPT Image 2 Skill 生成图片。',
    kind: 'provider-protocol', categories: ['cli', 'llm', 'image'], runtimeProtocol: 'cli:codex', executor: { type: 'native', adapter: 'codex-cli' }, auth: { type: 'none' },
    models: { endpoint: '/api/cli/codex/models', kind: 'openai' },
    operations: {
      'llm.chat': { label: 'Codex 对话', method: 'POST', path: '/api/cli/codex/chat' },
      'image.generate': { label: 'GPT Image 2', method: 'POST', path: '/api/cli/codex/generate-image' },
      'image.edit': { label: 'GPT Image 2 编辑', method: 'POST', path: '/api/cli/codex/edit-image', requestMode: 'multipart' },
    },
    modelProfiles: {
      'gpt-5.5': { label: 'GPT 5.5', capabilities: ['llm.chat', 'llm.chat.vision'] },
      'gpt-image-2': { label: 'GPT Image 2', capabilities: ['image.generate', 'image.edit'] },
      'codex-image': { label: 'Codex Image', match: ['gpt-image-'], capabilities: ['image.generate', 'image.edit'] },
      'codex-chat': { label: 'Codex Chat', match: ['gpt-', 'o1', 'o3', 'o4', 'codex-'], capabilities: ['llm.chat', 'llm.chat.vision'] },
    },
    docs: [{ title: 'OpenAI Codex CLI', url: '/api/cli/codex/help' }],
  },
  'cli:gemini': {
    id: 'cli:gemini', label: 'Gemini CLI', summary: '复用本机 Antigravity 或 Gemini 登录态进行对话，并在 CLI 支持时生成图片。',
    kind: 'provider-protocol', categories: ['cli', 'llm', 'image'], runtimeProtocol: 'cli:gemini', executor: { type: 'native', adapter: 'gemini-cli' }, auth: { type: 'none' },
    models: { endpoint: '/api/cli/gemini/models', kind: 'openai' },
    operations: {
      'llm.chat': { label: 'Gemini CLI 对话', method: 'POST', path: '/api/cli/gemini/chat' },
      'image.generate': { label: 'Gemini CLI 生图', method: 'POST', path: '/api/cli/gemini/generate-image' },
      'image.edit': { label: 'Gemini CLI 图片编辑', method: 'POST', path: '/api/cli/gemini/edit-image', requestMode: 'multipart' },
    },
    modelProfiles: {
      auto: { label: '自动选择', capabilities: ['llm.chat', 'llm.chat.vision'] },
      'gemini-3.1-flash-image': { label: 'Gemini 3.1 Flash Image', capabilities: ['image.generate', 'image.edit'] },
    },
    docs: [{ title: 'Gemini CLI', url: '/api/cli/gemini/help' }],
  },
  openai: {
    id: 'openai',
    label: 'OpenAI 兼容同步',
    summary: '站点连接协议：Bearer Key、OpenAI 风格 /v1/models、同步 JSON/SSE 请求。模型可单独选择 OpenAI、Gemini、Kling 等执行协议。',
    kind: 'provider-protocol',
    categories: ['sync', 'openai-compatible', 'sse'],
    runtimeProtocol: 'openai',
    auth: PROTOCOLS.openai.auth,
    models: PROTOCOLS.openai.models,
    stream: true,
  },
  'openai-relay': {
    id: 'openai-relay',
    label: 'OpenAI 中转平台',
    summary: 'Bearer Key 中转站连接协议；参考图通过 /v1/images/generations 的 JSON image 数组提交，适用于 AILXP 等不接收 multipart edits 的平台。',
    kind: 'provider-protocol',
    categories: ['relay', 'openai-compatible', 'image', 'video'],
    runtimeProtocol: 'openai',
    auth: PROTOCOLS.openai.auth,
    models: PROTOCOLS.openai.models,
    stream: true,
  },
  'aliyun-bailian': {
    id: 'aliyun-bailian',
    label: '阿里云百炼',
    summary: '阿里云百炼业务空间专属 OpenAI 兼容连接；支持千问、视觉、Coder、Omni 及百炼托管的兼容对话模型。',
    kind: 'provider-protocol',
    categories: ['llm', 'vision', 'tools', 'openai-compatible', 'aliyun'],
    runtimeProtocol: 'openai',
    auth: PROTOCOLS.openai.auth,
    models: PROTOCOLS.openai.models,
    stream: true,
    docs: [{ title: '百炼 OpenAI Chat 兼容接口', url: 'https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope' }],
  },
  apimart: {
    id: 'apimart',
    label: '异步协议',
    summary: '异步聚合站点连接协议，兼容 APIMart、APIB 等同类网关；普通对话直接返回，图片、视频和音乐任务可提交后轮询结果。',
    kind: 'provider-protocol',
    categories: ['aggregator', 'multi-model'],
    runtimeProtocol: 'apimart',
    executor: { type: 'native', adapter: 'apimart-media' },
    auth: PROTOCOLS.apimart?.auth || PROTOCOLS.openai.auth,
    models: PROTOCOLS.apimart?.models || PROTOCOLS.openai.models,
  },
  agtoken: {
    id: 'agtoken',
    label: 'AG 平台',
    summary: 'AGToken 视频 API 平台；使用 Bearer Key，并由 AG 模型协议自动适配统一、Seedance 和 Wan 异步任务格式。',
    kind: 'provider-protocol',
    categories: ['video', 'task', 'seedance', 'wan'],
    runtimeProtocol: 'agtoken-video',
    executor: { type: 'native', adapter: 'agtoken-media' },
    auth: PROTOCOLS['agtoken-video'].auth,
    models: PROTOCOLS['agtoken-video'].models,
  },
  zkki: {
    id: 'zkki',
    label: 'ZKKI 平台',
    summary: 'ZKKI 图片与视频 API 平台；使用 Bearer Key，模型由 ZKKI 模型协议统一适配。',
    kind: 'provider-protocol',
    categories: ['image', 'video', 'task', 'seedream', 'seedance'],
    runtimeProtocol: 'zkki-model',
    executor: { type: 'native', adapter: 'zkki-media' },
    auth: PROTOCOLS['zkki-model'].auth,
    models: PROTOCOLS['zkki-model'].models,
  },
  xai: {
    id: 'xai',
    label: 'Grok 官方 API',
    summary: 'Grok 官方 api.x.ai 连接协议，使用 Grok API Key，支持 Grok 文本、Imagine 图片和异步视频。',
    kind: 'provider-protocol',
    categories: ['grok', 'llm', 'image', 'video', 'official'],
    runtimeProtocol: 'xai',
    auth: PROTOCOLS.xai.auth,
    models: PROTOCOLS.xai.models,
    stream: true,
  },
  grok2api: {
    id: 'grok2api',
    label: 'Grok2API',
    summary: 'Grok2API 本地或远程网关连接协议，使用 g2a_ Key，支持 Grok 对话、图片、视频和语音模型。',
    kind: 'provider-protocol',
    categories: ['grok', 'multimodal', 'openai-compatible', 'task'],
    runtimeProtocol: 'grok2api',
    executor: { type: 'native', adapter: 'grok2api-media' },
    auth: PROTOCOLS.grok2api.auth,
    models: PROTOCOLS.grok2api.models,
    stream: true,
  },
  agnes: {
    id: 'agnes',
    label: 'Agnes AI',
    summary: 'Agnes 原生连接协议，支持兼容对话、JSON 图片和异步视频任务。',
    kind: 'provider-protocol',
    categories: ['llm', 'image', 'video', 'free'],
    runtimeProtocol: 'agnes',
    executor: { type: 'native', adapter: 'agnes-media' },
    auth: PROTOCOLS.agnes.auth,
    models: PROTOCOLS.agnes.models,
    stream: true,
  },
  modelscope: {
    id: 'modelscope',
    label: 'ModelScope',
    summary: 'ModelScope 原生连接协议，支持 OpenAI 兼容对话、异步图片任务和模型专属 LoRA。',
    kind: 'provider-protocol',
    categories: ['llm', 'image', 'lora'],
    runtimeProtocol: 'modelscope',
    executor: { type: 'native', adapter: 'modelscope-media' },
    auth: PROTOCOLS.modelscope.auth,
    models: PROTOCOLS.modelscope.models,
    stream: true,
  },
  volcengine: {
    id: 'volcengine',
    label: '火山引擎',
    summary: '火山方舟原生连接协议，使用方舟 API Key，支持兼容对话、Seedream 图片和 Seedance 异步视频任务。',
    kind: 'provider-protocol',
    categories: ['llm', 'image', 'video', 'task', 'seedream', 'seedance'],
    runtimeProtocol: 'volcengine',
    executor: { type: 'native', adapter: 'volcengine-media' },
    auth: PROTOCOLS.volcengine.auth,
    models: PROTOCOLS.volcengine.models,
    stream: true,
    operations: PROTOCOLS.volcengine.operations,
    modelProfiles: PROTOCOLS.volcengine.modelProfiles,
    uiSchemas: PROTOCOLS.volcengine.uiSchemas,
    paramSchema: PROTOCOLS.volcengine.paramSchema,
    docs: PROTOCOLS.volcengine.docs,
  },
  'volcengine-speech': {
    id: 'volcengine-speech', label: '豆包语音', summary: '豆包语音新版 X-Api-Key 协议，与火山方舟 API Key 分开配置。',
    kind: 'provider-protocol', categories: ['audio', 'tts', 'speech'], runtimeProtocol: 'volcengine-speech',
    auth: PROTOCOLS['volcengine-speech'].auth, models: PROTOCOLS['volcengine-speech'].models,
    operations: PROTOCOLS['volcengine-speech'].operations, modelProfiles: PROTOCOLS['volcengine-speech'].modelProfiles,
    uiSchemas: PROTOCOLS['volcengine-speech'].uiSchemas, paramSchema: PROTOCOLS['volcengine-speech'].paramSchema, docs: PROTOCOLS['volcengine-speech'].docs,
  },
  minimax: {
    id: 'minimax',
    label: 'MiniMax H3',
    summary: 'MiniMax V2 视频连接协议，适配 metaso.cn MiniMax H3 网关和同格式服务。',
    kind: 'provider-protocol',
    categories: ['video', 'task', 'multimodal', 'minimax', 'hailuo'],
    runtimeProtocol: 'minimax',
    executor: { type: 'native', adapter: 'minimax-media' },
    auth: PROTOCOLS.minimax.auth,
    models: PROTOCOLS.minimax.models,
    operations: PROTOCOLS.minimax.operations,
    modelProfiles: PROTOCOLS.minimax.modelProfiles,
    uiSchemas: PROTOCOLS.minimax.uiSchemas,
    paramSchema: PROTOCOLS.minimax.paramSchema,
    docs: PROTOCOLS.minimax.docs,
  },
  runninghub: {
    id: 'runninghub',
    label: 'RunningHub',
    summary: 'RunningHub 原生连接协议，包含 RH币 Key、账户余额 Key、标准模型、工作流与 AI 应用。',
    kind: 'provider-protocol',
    categories: ['multi-model', 'workflow', 'ai-app'],
    runtimeProtocol: 'runninghub',
    executor: { type: 'native', adapter: 'runninghub' },
    auth: PROTOCOLS.runninghub.auth,
    models: PROTOCOLS.runninghub.models,
  },
  lovart: {
    id: 'lovart',
    label: 'Lovart',
    summary: 'Lovart 官方 OpenAPI（OpenClaw）：AK/SK HMAC-SHA256 请求签名，catalog 动态模型表，chat → send/watch/result 生成图像与视频。',
    kind: 'provider-protocol',
    categories: ['image', 'video', 'design', 'agent'],
    runtimeProtocol: 'lovart',
    // 鉴权既不是 Bearer 也不是固定头，而是 AK/SK 的 HMAC-SHA256 请求签名：
    //   sig = HMAC_SHA256(secret_key, METHOD + "\n" + path + "\n" + timestamp秒)
    // 头 X-Access-Key / X-Timestamp / X-Signature / X-Signed-Method / X-Signed-Path。
    // 该表只描述协议面；真正的签名与 send→watch→result 在 electron/provider-adapter-lovart.cjs。
    auth: { type: 'hmac_sha256' },
    models: { endpoint: '/v1/openapi/tools/catalog', kind: 'lovart' },
    operations: {
      'image.generate': {
        label: '生成图像',
        method: 'POST',
        path: '/v1/openapi/chat',
        requestMode: 'json',
        bodyTemplate: { prompt: '{{prompt}}', project_id: '{{projectId}}', tool_config: { prefer_tool_categories: { IMAGE: ['{{model}}'] } } },
        poll: { statusPath: '/v1/openapi/chat/status', resultPath: '/v1/openapi/chat/result', idField: 'thread_id', artifactField: '$.items[*].artifacts[*].content' },
        response: { artifacts: '$.items[*].artifacts[*].content' },
      },
      'video.generate': {
        label: '生成视频',
        method: 'POST',
        path: '/v1/openapi/chat',
        requestMode: 'json',
        bodyTemplate: { prompt: '{{prompt}}', project_id: '{{projectId}}', tool_config: { prefer_tool_categories: { VIDEO: ['{{model}}'] } } },
        poll: { statusPath: '/v1/openapi/chat/status', resultPath: '/v1/openapi/chat/result', idField: 'thread_id', artifactField: '$.items[*].artifacts[*].content' },
        response: { artifacts: '$.items[*].artifacts[*].content' },
      },
      'llm.chat': {
        label: 'Agent 对话',
        method: 'POST',
        path: '/v1/openapi/chat',
        requestMode: 'json',
        bodyTemplate: { prompt: '{{prompt}}', project_id: '{{projectId}}' },
        poll: { statusPath: '/v1/openapi/chat/status', resultPath: '/v1/openapi/chat/result', idField: 'thread_id' },
        response: { text: '$.items[*].text' },
      },
    },
    docs: [
      { title: 'Lovart OpenClaw User Guide', url: 'https://lovart.notion.site/Lovart-OpenClaw-User-Guide-33da46b16a0f80f6a7fff8e4896b9fca' },
    ],
  },
};
// ── 内建/可运行协议集合（源 protocols.ts:3010-3016）──────────────────
const BUILTIN_MODEL_PROTOCOL_IDS = new Set(Object.keys(PROTOCOLS))
const BUILTIN_PROVIDER_PROTOCOL_IDS = new Set(Object.keys(PROVIDER_PROTOCOLS))
const DECLARED_VIDEO_RUNTIME_PROTOCOL_IDS = new Set(['v2-unified', 'grok', 'xai', 'grok2api', 'kling', 'pixverse', 'pika', 'vidu', 'wanxiang', 'minimax', 'volcengine'])
const DECLARED_AUDIO_RUNTIME_PROTOCOL_IDS = new Set(['v2-unified', 'grok2api', 'suno', 'minimax', 'volcengine-speech'])
const RUNNABLE_MODEL_PROTOCOL_IDS = new Set(['openai', 'anthropic', 'gemini', 'gemini-generations', 'gpt-best-images', 'xai', 'apimart', 'apimart-gemini', 'apimart-claude', 'apimart-media', 'agtoken-video', 'zkki-model', 'midjourney', 'agnes', 'modelscope', 'volcengine', 'runninghub', ...DECLARED_VIDEO_RUNTIME_PROTOCOL_IDS, ...DECLARED_AUDIO_RUNTIME_PROTOCOL_IDS])
const RUNNABLE_PROVIDER_PROTOCOL_IDS = new Set(['cli:pippit', 'cli:jimeng', 'cli:dreamina-canvas', 'cli:codex', 'cli:gemini', 'ollama', 'openai', 'aliyun-bailian', 'xai', 'apimart', 'agtoken-video', 'zkki-model', 'grok2api', 'agnes', 'modelscope', 'volcengine', 'volcengine-speech', 'minimax', 'runninghub', 'lovart'])
const INTERNAL_MODEL_PROTOCOL_IDS = new Set(['ollama', 'apimart-gemini', 'apimart-claude', 'apimart-media'])
const MODEL_PROTOCOL_ALIASES = {
  'openai-chat': {
    runtimeProtocol: 'openai',
    label: 'OpenAI Chat',
    summary: '模型执行协议：OpenAI Chat Completions / Responses 风格，适合 LLM、视觉、工具调用与结构化输出。',
    categories: ['llm', 'vision', 'tools', 'responses'],
    capabilities: ['llm.chat', 'llm.chat.vision', 'llm.tools', 'llm.responses', 'llm.structured_output'],
  },
  'openai-image': {
    runtimeProtocol: 'openai',
    label: 'OpenAI Image',
    summary: '模型执行协议：OpenAI Images 风格，适合文生图、图像编辑和图像变体。',
    categories: ['image'],
    capabilities: ['image.generate', 'image.edit', 'image.variation'],
  },
  'openai-audio': {
    runtimeProtocol: 'openai',
    label: 'OpenAI Audio',
    summary: '模型执行协议：OpenAI Audio 风格，适合 TTS、转写、翻译等语音能力。',
    categories: ['audio'],
    capabilities: ['audio.tts', 'audio.transcribe', 'audio.translate'],
  },
  'openai-embedding': {
    runtimeProtocol: 'openai',
    label: 'OpenAI Embedding',
    summary: '模型执行协议：OpenAI Embeddings 风格，适合向量化模型。',
    categories: ['embedding'],
    capabilities: ['embeddings.create'],
  },
  'openai-files': {
    runtimeProtocol: 'openai',
    label: 'OpenAI Files',
    summary: '模型执行协议：OpenAI Files / Batches 风格，适合文件上传、批处理任务。',
    categories: ['files', 'batches'],
    capabilities: ['files.upload', 'batches.create'],
  },
  'gemini-chat': {
    runtimeProtocol: 'gemini',
    label: 'Gemini Chat',
    summary: '模型执行协议：Gemini generateContent 风格，适合 Gemini 文本和视觉模型。',
    categories: ['llm', 'vision'],
    capabilities: ['llm.chat', 'llm.chat.vision', 'llm.tools'],
  },
  'gemini-image': {
    runtimeProtocol: 'gemini',
    label: 'Gemini Image',
    summary: '模型执行协议：Gemini / Imagen 图像生成风格，支持参考图编辑。',
    categories: ['image'],
    capabilities: ['image.generate', 'image.edit'],
  },
  'anthropic-chat': {
    runtimeProtocol: 'anthropic',
    label: 'Anthropic Chat',
    summary: '模型执行协议：Anthropic Messages 风格，适合 Claude 文本和视觉模型。',
    categories: ['llm', 'vision'],
    capabilities: ['llm.chat', 'llm.chat.vision', 'llm.tools'],
  },
};
const BUILTIN_PROVIDER_SITE_RULES = [
  { providerProtocolId: 'apimart', siteRules: [{ hosts: ['api.apimart.ai'], hostSuffixes: ['.apimart.ai'], priority: 100 }] },
  // apib.ai exposes an OpenAI-compatible image API. Treating it as the APIMart
  // Gemini protocol sends requests to the wrong host/path and ignores its base URL.
  { providerProtocolId: 'openai', siteRules: [{ hosts: ['apib.ai'], hostSuffixes: ['.apib.ai'], priority: 100 }] },
  { providerProtocolId: 'aliyun-bailian', siteRules: [{ hostSuffixes: ['.maas.aliyuncs.com'], pathPrefixes: ['/compatible-mode/v1'], priority: 140 }, { hosts: ['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com', 'dashscope-us.aliyuncs.com'], pathPrefixes: ['/compatible-mode/v1'], priority: 120 }] },
  { providerProtocolId: 'agtoken', siteRules: [{ hosts: ['agtoken.vip'], hostSuffixes: ['.agtoken.vip'], priority: 100 }] },
  { providerProtocolId: 'zkki', siteRules: [{ hosts: ['api.zkki.net'], hostSuffixes: ['.zkki.net'], priority: 100 }] },
  { providerProtocolId: 'modelscope', siteRules: [{ hosts: ['api-inference.modelscope.cn', 'api-inference.modelscope.ai'], priority: 100 }] },
  { providerProtocolId: 'volcengine', siteRules: [{ hosts: ['ark.cn-beijing.volces.com'], hostSuffixes: ['.volces.com'], pathPrefixes: ['/api/v3'], priority: 100 }] },
  { providerProtocolId: 'minimax', siteRules: [{ hosts: ['api.minimax.cn', 'api-bj.minimaxi.com'], priority: 120 }, { hosts: ['metaso.cn'], pathPrefixes: ['/api/minimax'], priority: 110 }, { hosts: ['api.minimax.io'], hostSuffixes: ['.minimax.io'], priority: 100 }] },
  { providerProtocolId: 'agnes', siteRules: [{ hosts: ['apihub.agnes-ai.com'], hostSuffixes: ['.agnes-ai.com'], priority: 100 }] },
  { providerProtocolId: 'runninghub', siteRules: [{ hosts: ['www.runninghub.ai', 'runninghub.ai'], hostSuffixes: ['.runninghub.ai'], priority: 100 }] },
];

// ── 视频比例归一化（源 protocols.ts:81-101）────────────────────────────
function normalizeApimartVideoAspectRatio(aspectRatio, size) {
  const explicitAspect = String(aspectRatio ?? '').trim().toLowerCase()
  // 保留显式选择，便于校验报出不支持的值。
  if (explicitAspect) return explicitAspect

  const legacySize = String(size ?? '').trim().toLowerCase()
  if (APIMART_VIDEO_ASPECT_OPTIONS.includes(legacySize)) return legacySize
  const dimensions = legacySize.match(/^(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)$/i)
  if (!dimensions) return '16:9'
  const width = Number(dimensions[1])
  const height = Number(dimensions[2])
  if (!(width > 0 && height > 0)) return '16:9'
  const ratio = width / height
  return ASPECT_OPTIONS.reduce((nearest, candidate) => {
    const [candidateWidth, candidateHeight] = candidate.split(':').map(Number)
    const [nearestWidth, nearestHeight] = nearest.split(':').map(Number)
    const candidateDistance = Math.abs(Math.log(ratio / (candidateWidth / candidateHeight)))
    const nearestDistance = Math.abs(Math.log(ratio / (nearestWidth / nearestHeight)))
    return candidateDistance < nearestDistance ? candidate : nearest
  }, '16:9')
}

// ── 模型协议别名（源 protocols.ts:3242-3273）──────────────────────────
function modelProtocolAlias(id) {
  return MODEL_PROTOCOL_ALIASES[String(id || '').trim().toLowerCase()] || null
}

function suggestModelProtocol(providerProtocol, modelName) {
  const provider = String(providerProtocol || '').trim().toLowerCase()
  const model = String(modelName || '').trim().toLowerCase()
  if (!model) return ''
  // 源 :3250-3256 的远程协议包 bindings 分支已移除（见文件头说明 3）。
  if (provider === 'agtoken' || provider === 'agtoken-video') {
    if (/(gpt|claude|deepseek|qwen|glm|kimi|llama|mistral|gemini)(?!.*(?:image|imagen|banana|video|veo))/i.test(model)) return 'openai-chat'
    if (/(gpt[-_.]?image|gemini.*image|imagen|nano[-_. ]?banana|seedream|qwen.?image|dall.?e|flux|recraft|ideogram|midjourney|jimeng|kolors|photon|cogview)/i.test(model)) return 'openai-image'
    return 'agtoken-video'
  }
  if (provider === 'zkki' || provider === 'zkki-model') {
    if (/(gpt|claude|deepseek|qwen|glm|kimi|llama|mistral|gemini)(?!.*(?:image|imagen|banana|video|veo))/i.test(model)) return 'openai-chat'
    return 'zkki-model'
  }
  if (provider !== 'apimart') return ''

  if (model === 'gpt-4o-mini-tts') return 'apimart'
  if (/(^|[-_./\s])(midjourney|mj)([-_./\s]|$)|\bniji\b/.test(model)) return 'midjourney'
  if (/\bclaude\b|anthropic|\bgemini\b|\bimagen\b/.test(model)) return 'apimart'
  if (/(^|[-_./\s])(veo|kling|suno|pixverse|pika|vidu|luma|runway|seedance|seedream|hailuo|minimax|wanx?|cogvideo|music|udio)(\d|[-_./\s]|$)/.test(model)) return 'apimart'
  return ''
}

// ── 站点规则匹配（源 protocols.ts:3292-3319；远程 bindings 参数保留供调用方注入）──
function providerSiteRuleMatches(baseUrl, bindings) {
  let parsed
  try { parsed = new URL(String(baseUrl || '').trim()) } catch { return [] }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '')
  const path = parsed.pathname || '/'
  const matches = []
  let order = 0
  for (const binding of bindings) for (const rule of binding.siteRules || []) {
    order += 1
    const hosts = (rule.hosts || []).map((value) => value.toLowerCase())
    const suffixes = (rule.hostSuffixes || []).map((value) => value.toLowerCase())
    const prefixes = rule.pathPrefixes || []
    const exact = hosts.includes(host) ? 1 : 0
    const suffix = suffixes.some((value) => host.endsWith(value) && host.length > value.length) ? 1 : 0
    if (!exact && !suffix) continue
    const pathMatch = !prefixes.length || prefixes.some((value) => path === value || path.startsWith(value.endsWith('/') ? value : value + '/'))
    if (!pathMatch) continue
    matches.push({
      providerProtocolId: binding.providerProtocolId,
      exact,
      suffix,
      path: prefixes.length ? Math.max(...prefixes.filter((value) => path === value || path.startsWith(value.endsWith('/') ? value : value + '/')).map((value) => value.length), 0) : 0,
      priority: Number.isFinite(rule.priority) ? Number(rule.priority) : 0,
      order,
    })
  }
  return matches.sort((a, b) => b.exact - a.exact || b.suffix - a.suffix || b.path - a.path || b.priority - a.priority || a.order - b.order)
}

/**
 * 返回用户点击“验证协议”时应尝试的平台协议顺序。
 * 源 protocols.ts:3326-3334；远程站点规则分支已移除（见文件头说明 3），只用内置规则。
 */
function providerProtocolCandidates(baseUrl, currentProtocol = 'openai') {
  const builtin = providerSiteRuleMatches(baseUrl, BUILTIN_PROVIDER_SITE_RULES)
  const current = String(currentProtocol || '').trim().toLowerCase()
  return builtin
    .map((match) => match.providerProtocolId)
    .concat(current, 'openai')
    .filter((id, index, values) => !!id && (!!PROVIDER_PROTOCOLS[id] || id === 'gemini-http') && values.indexOf(id) === index)
}

// ── 协议列表（源 protocols.ts:3336-3387）──────────────────────────────
function listProtocols() {
  return listProviderProtocols()
}

function listProviderProtocols() {
  customProtocolStore.ensureLoaded()
  return Object.values(PROVIDER_PROTOCOLS).map((p) => ({
    id: p.id,
    label: p.label,
    summary: p.summary,
    categories: p.categories || [],
    capabilities: p.categories || [],
    runtimeProtocol: p.runtimeProtocol || p.id,
    runnable: RUNNABLE_PROVIDER_PROTOCOL_IDS.has(p.runtimeProtocol || p.id),
  }))
}

function listModelProtocols() {
  customProtocolStore.ensureLoaded()
  return Object.values(PROTOCOLS).filter((p) => !INTERNAL_MODEL_PROTOCOL_IDS.has(p.id)).map((p) => ({
    id: p.id,
    label: p.label,
    summary: p.summary,
    categories: p.categories || [],
    capabilities: Object.keys(p.capabilities),
    runtimeProtocol: p.runtimeProtocol || p.id,
    runnable: BUILTIN_MODEL_PROTOCOL_IDS.has(p.id)
      ? RUNNABLE_MODEL_PROTOCOL_IDS.has(p.id)
      : RUNNABLE_MODEL_PROTOCOL_IDS.has(p.runtimeProtocol || p.id),
  }))
}

function listProtocolDetails() {
  return listModelProtocolDetails()
}

function listProviderProtocolDetails() {
  // 自建协议在装载后已进 PROVIDER_PROTOCOLS，这里按 store 如实判定来源（源 :3375；remote 分支见文件头说明 3）。
  customProtocolStore.ensureLoaded()
  return Object.values(PROVIDER_PROTOCOLS).map((p) => ({
    ...p,
    scope: 'provider',
    builtin: BUILTIN_PROVIDER_PROTOCOL_IDS.has(p.id),
    origin: customProtocolStore.originOf('provider', p.id),
  }))
}

function listModelProtocolDetails() {
  // 自建协议在装载后已进 PROTOCOLS，这里按 store 如实判定来源（源 :3385；remote 分支见文件头说明 3）。
  customProtocolStore.ensureLoaded()
  return Object.values(PROTOCOLS).filter((p) => !INTERNAL_MODEL_PROTOCOL_IDS.has(p.id)).map((p) => ({
    ...p,
    scope: 'model',
    runtimeProtocol: p.runtimeProtocol || p.id,
    builtin: BUILTIN_MODEL_PROTOCOL_IDS.has(p.id),
    origin: customProtocolStore.originOf('model', p.id),
  }))
}

// ── 协议 ID 规范化（源 protocols.ts:3389-3413）────────────────────────
/** 源 :3391/:3400/:3597 的 dx-protocol/v2 查询；函数内惰性 require，规避模块初始化顺序问题。 */
function getProtocolV2(kind, id) {
  return require('./repository.cjs').getProtocolV2(kind, id)
}

function normalizeProtocolId(id, fallback = 'openai') {
  const key = String(id || '').trim().toLowerCase()
  return PROTOCOLS[key] || MODEL_PROTOCOL_ALIASES[key] || PROVIDER_PROTOCOLS[key] || getProtocolV2('model', key) ? key : fallback
}

/**
 * 站点配置必须保存平台协议 ID，而不是其底层运行时协议 ID。
 * 同时兼容早期版本保存的 agtoken-video / zkki-model 等运行时 ID。
 */
function normalizeProviderProtocolId(id, fallback = 'openai') {
  const key = String(id || '').trim().toLowerCase()
  if (getProtocolV2('provider', key)) return key
  if (PROVIDER_PROTOCOLS[key]) return key
  const provider = Object.values(PROVIDER_PROTOCOLS).find((item) => (item.runtimeProtocol || item.id) === key)
  return provider?.id || fallback
}

function normalizeProtocol(id, fallback = 'openai') {
  const key = String(id || '').trim().toLowerCase()
  if (key === 'gemini-http') return 'gemini'
  if (PROTOCOLS[key]) return PROTOCOLS[key].runtimeProtocol || key
  if (MODEL_PROTOCOL_ALIASES[key]) return MODEL_PROTOCOL_ALIASES[key].runtimeProtocol
  if (PROVIDER_PROTOCOLS[key]) return PROVIDER_PROTOCOLS[key].runtimeProtocol
  return fallback
}

/** 源 :3415-3420。 */
function assertRunnableProtocol(id, surface) {
  const key = String(id || '').trim().toLowerCase()
  if (key && key !== 'midjourney' && !PROTOCOLS[normalizeProtocol(key, '')]) {
    throw new Error(`${surface} 协议「${key}」还在待适配，暂时不能直接调用。`)
  }
}

// ── URL 拼接与鉴权头（源 protocols.ts:3423-3445）──────────────────────
// 内联自 agtokenEndpoint.ts:2-9（本地无 .cjs）。
function normalizeAgTokenApiBaseUrl(baseUrl) {
  const value = String(baseUrl || '').trim()
  try {
    const url = new URL(value)
    if (/^(?:[a-z0-9-]+\.)?agtoken\.vip$/i.test(url.hostname)) return url.origin
  } catch { /* 保留无效 URL，交给请求层报错 */ }
  return value
}

function joinUrl(baseUrl, endpoint) {
  if (/^https?:\/\//i.test(endpoint)) return endpoint
  const base = normalizeAgTokenApiBaseUrl(baseUrl).replace(/\/+$/, '')
  if (!base) throw new Error('缺少 base_url')
  let ep = '/' + String(endpoint || '').replace(/^\/+/, '')
  for (const prefix of ['/api/v3', '/v1', '/v2', '/v1beta']) {
    if (base.endsWith(prefix) && ep.startsWith(prefix + '/')) {
      ep = ep.slice(prefix.length)
      break
    }
  }
  return base + ep
}

function buildAuthHeaders(def, apiKey) {
  const key = String(apiKey || '').trim()
  if (!key || def.auth.type === 'none') return {}
  const { type, header, prefix } = def.auth
  if (type === 'api_key_header') return { [header || 'x-api-key']: key }
  if (type === 'google_api_key') return { [header || 'x-goog-api-key']: key }
  return { [header || 'Authorization']: (prefix ?? 'Bearer ') + key }
}

// ── 请求体构造（源 protocols.ts:3454-3486）────────────────────────────
function messagesFrom(input) {
  if (Array.isArray(input.messages) && input.messages.length) return input.messages
  return [{ role: 'user', content: String(input.prompt || 'ping') }]
}

function buildBody(kind, model, input, params) {
  if (kind === 'openai_chat') {
    const messages = messagesFrom(input)
    const hasSystemMessage = messages.some((message) => message.role === 'system')
    return {
      model,
      messages: input.system && !hasSystemMessage
        ? [{ role: 'system', content: input.system }, ...messages]
        : messages,
      stream: false,
      ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
      ...(params.max_tokens !== undefined ? { max_tokens: params.max_tokens } : {}),
    }
  }
  if (kind === 'anthropic_messages') {
    const msgs = messagesFrom(input).filter((m) => m.role !== 'system')
    const system = input.system || messagesFrom(input).find((m) => m.role === 'system')?.content
    return {
      model,
      max_tokens: params.max_tokens || 1024,
      messages: msgs.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
      ...(system ? { system } : {}),
    }
  }
  // gemini_content
  const parts = messagesFrom(input).map((m) => ({ text: m.content }))
  return { contents: [{ parts }], ...(params.max_tokens !== undefined ? { generationConfig: { maxOutputTokens: params.max_tokens } } : {}) }
}

// ── 响应解析（源 protocols.ts:3489-3515）──────────────────────────────
function unwrapProviderPayload(def, payload) {
  if (!def.unwrapData) return payload
  if (payload && typeof payload === 'object' && 'data' in payload && !('choices' in payload) && !('candidates' in payload)) {
    return payload.data
  }
  return payload
}

function parseBody(kind, payload) {
  if (kind === 'openai_chat') {
    const c = payload?.choices?.[0]
    return { text: c?.message?.content || c?.text || '', usage: payload?.usage }
  }
  if (kind === 'anthropic_text') {
    const blocks = payload?.content || []
    const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('')
    return { text, usage: payload?.usage }
  }
  // gemini_text
  const cands = payload?.candidates || []
  const text = cands
    .flatMap((c) => c?.content?.parts || [])
    .filter((p) => p?.text)
    .map((p) => p.text)
    .join('\n')
  return { text, usage: payload?.usageMetadata }
}

// ── 模型列表解析（源 protocols.ts:3518-3580）──────────────────────────
function parseModels(kind, payload) {
  return parseModelCatalog(kind, payload).map((item) => item.model)
}

function catalogOperations(model) {
  const value = model?.operations
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean)
  if (value && typeof value === 'object') return Object.keys(value)
  return []
}

function catalogCapabilities(model) {
  const value = model?.capabilities
  if (Array.isArray(value)) return value.map((item) => typeof item === 'string' ? item : String(item?.id || item?.name || '')).filter(Boolean)
  if (value && typeof value === 'object') return Object.keys(value)
  return []
}

function catalogMediaType(model) {
  const declared = String(model?.media_type || model?.mediaType || '').trim().toLowerCase()
  if (['llm', 'text', 'chat', 'language'].includes(declared)) return 'llm'
  if (['image', 'video', 'audio'].includes(declared)) return declared
  const operations = [...catalogOperations(model), ...catalogCapabilities(model)].map((item) => item.toLowerCase())
  if (operations.some((item) => /(?:^|[._-])image(?:[._-]|$)/.test(item))) return 'image'
  if (operations.some((item) => /(?:^|[._-])video(?:[._-]|$)/.test(item))) return 'video'
  if (operations.some((item) => /(?:^|[._-])(?:audio|speech|music|transcri)(?:[._-]|$)/.test(item))) return 'audio'
  if (operations.some((item) => /(?:chat|responses|completion|llm)/.test(item))) return 'llm'
  return undefined
}

/** 解析模型目录，不丢弃 OpenAI 兼容扩展元数据。源 :3549-3580。 */
function parseModelCatalog(kind, payload) {
  if (payload?.data && typeof payload.data === 'object' && !Array.isArray(payload.data)) {
    payload = payload.data
  }
  // Lovart catalog：{ code, message, data: { tools: [{ name, display_name, category, is_premium }] } }。
  // category 只有 IMAGE / VIDEO / 3D；3D 在本仓没有对应能力，如实返回无 type（不硬塞）。
  if (kind === 'lovart') {
    return (payload?.tools || [])
      .map((tool) => {
        const category = String(tool?.category || '').trim().toUpperCase()
        return {
          model: String(tool?.name || ''),
          name: String(tool?.display_name || '').trim() || undefined,
          type: category === 'IMAGE' ? 'image' : category === 'VIDEO' ? 'video' : undefined,
        }
      })
      .filter((item) => !!item.model)
  }
  if (kind === 'gemini') {
    return (payload?.models || [])
      .map((m) => ({ model: String(m?.name || '').replace(/^models\//, ''), name: String(m?.displayName || '').trim() || undefined }))
      .filter((item) => !!item.model)
  }
  const items = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models)
      ? payload.models
      : Array.isArray(payload?.list)
        ? payload.list
        : []
  // openai / anthropic 通常是 data[].id；一些中转站会用 name/model 或直接返回字符串数组。
  return items.map((m) => {
    if (typeof m === 'string') return { model: m }
    const model = String(m?.id || m?.model || m?.name || '')
    const name = String(m?.display_name || m?.displayName || (m?.name !== model ? m?.name : '') || '').trim() || undefined
    const type = catalogMediaType(m)
    const metadata = Object.fromEntries(Object.entries({
      media_type: m?.media_type ?? m?.mediaType,
      operations: m?.operations,
      capabilities: m?.capabilities,
      parameters: m?.parameters,
      pricing: m?.pricing,
    }).filter(([, value]) => value !== undefined))
    return { model, ...(name ? { name } : {}), ...(type ? { type } : {}), ...(Object.keys(metadata).length ? { metadata } : {}) }
  }).filter((item) => !!item.model)
}

// ── 平台协议 ID 与鉴权要求（源 protocols.ts:3591-3600）────────────────
function protocolIds() {
  customProtocolStore.ensureLoaded()
  return Object.keys(PROVIDER_PROTOCOLS)
}

function providerRequiresApiKey(protocol) {
  const id = normalizeProviderProtocolId(protocol, 'openai')
  const v2 = getProtocolV2('provider', id)
  if (v2?.protocol.kind === 'provider') return v2.protocol.auth.type !== 'none'
  return PROVIDER_PROTOCOLS[id]?.auth.type !== 'none'
}

// ── 对话请求构造（源 protocols.ts:3610-3636）──────────────────────────
// 内联自 agnesEndpoint.ts:1-14（本地无 .cjs）。
const AGNES_GLOBAL_API_BASE_URL = 'https://apihub.agnes-ai.com'
const AGNES_CHINA_API_BASE_URL = 'https://api.agnes-ai.cn'

function normalizeAgnesApiBaseUrl(value) {
  const raw = String(value || AGNES_GLOBAL_API_BASE_URL).trim().replace(/\/+$/, '')
  try {
    const parsed = new URL(raw)
    const host = parsed.hostname.toLowerCase()
    if (host === 'platform.agnes-ai.cn' || host === 'www.agnes-ai.cn' || host === 'agnes-ai.cn') return AGNES_CHINA_API_BASE_URL
    if (host === 'platform.agnes-ai.com' || host === 'www.agnes-ai.com' || host === 'agnes-ai.com') return AGNES_GLOBAL_API_BASE_URL
  } catch { /* 保留原值，交给 URL 校验报错 */ }
  return raw
}

function buildChatRequest(provider, model, input, params = {}, capability = 'llm') {
  const proto = normalizeProtocol(provider.protocol)
  const def = PROTOCOLS[proto]
  if (!def) throw new Error('协议 ' + (proto || provider.protocol) + ' 不支持对话调用')
  const cap = def.capabilities[capability]
  if (!cap) throw new Error('协议 ' + proto + ' 不支持能力 ' + capability)
  const endpoint = cap.endpoint.replace('{model}', encodeURIComponent(model))
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...(def.headers || {}),
    ...buildAuthHeaders(def, provider.api_key),
  }
  return {
    url: joinUrl(proto === 'agnes' ? normalizeAgnesApiBaseUrl(provider.base_url) : provider.base_url, endpoint),
    method: cap.method || 'POST',
    headers,
    body: buildBody(cap.body, model, input, params),
    parse: cap.parse,
  }
}

module.exports = {
  PROTOCOLS,
  PROVIDER_PROTOCOLS,
  ASPECT_OPTIONS,
  APIMART_VIDEO_ASPECT_OPTIONS,
  MODEL_PROTOCOL_ALIASES,
  BUILTIN_PROVIDER_SITE_RULES,
  BUILTIN_MODEL_PROTOCOL_IDS,
  BUILTIN_PROVIDER_PROTOCOL_IDS,
  DECLARED_VIDEO_RUNTIME_PROTOCOL_IDS,
  DECLARED_AUDIO_RUNTIME_PROTOCOL_IDS,
  RUNNABLE_MODEL_PROTOCOL_IDS,
  RUNNABLE_PROVIDER_PROTOCOL_IDS,
  INTERNAL_MODEL_PROTOCOL_IDS,
  normalizeApimartVideoAspectRatio,
  modelProtocolAlias,
  suggestModelProtocol,
  providerProtocolCandidates,
  listProtocols,
  listProviderProtocols,
  listModelProtocols,
  listProtocolDetails,
  listProviderProtocolDetails,
  listModelProtocolDetails,
  normalizeProtocolId,
  normalizeProviderProtocolId,
  normalizeProtocol,
  assertRunnableProtocol,
  normalizeAgTokenApiBaseUrl,
  normalizeAgnesApiBaseUrl,
  joinUrl,
  buildAuthHeaders,
  messagesFrom,
  buildBody,
  unwrapProviderPayload,
  parseBody,
  parseModels,
  catalogOperations,
  catalogCapabilities,
  catalogMediaType,
  parseModelCatalog,
  protocolIds,
  providerRequiresApiKey,
  buildChatRequest,
};