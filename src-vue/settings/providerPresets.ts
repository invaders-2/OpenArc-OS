/**
 * 「模型与服务商」的 8 条服务商预设（纯 TS：无 DOM、无网络、无 I/O，可离线单测）。
 *
 * 数据来源：调研包 artifacts/provider-presets/presets.json（逐条官方 baseUrl / 模型 id /
 * 能力 / docsUrl 与实测状态码）。这里**不编模型**：有官方清单的按调研原样落表；
 * 没有公开模型清单的（Lovart）models 为空并标 modelsSource:"catalog"，
 * 由 provider/models 拉取后再勾选，绝不用编造的模型名凑数。
 *
 * 协议契约（只消费，不实现）：
 *   · adapterType 是 ModelStore 的协议字段（provider/create|update 已支持透传）；
 *   · 镜像桥 electron/model-provider-bridge.cjs#mapProtocol(adapterType) 把 adapterType
 *     透传成 provider-protocol id：openai-compatible / openai → openai，其余按原文；
 *   · 本模块的 presetProtocolId() 与 mapProtocol 同口径，防漂移由单测逐条核对；
 *   · 协议是否真的落地由运行期 protocol/list 判定（见 presetProtocolStatus）——
 *     Anthropic 官方 Messages 与 Lovart 原生协议由另外的包实现，预设只消费其结果。
 *
 * 双密钥契约（Lovart）：credentialMode:"dual" 时，界面把 access_key / secret_key 组合成
 * 单个 JSON 字符串写进既有凭据后端（credentialSecret 是单个不透明字符串），
 * 形态固定为 {"accessKey":"...","secretKey":"..."}（combineDualCredential / parseDualCredential）。
 * Lovart 原生适配器（另一包）从这个 JSON 里取两把密钥；本模块是唯一序列化点，改形态必须同步改测试。
 */

/** 凭据形态：single = 一把 API Key；dual = access_key + secret_key 两把。 */
export type PresetCredentialMode = "single" | "dual";

/** 调研产出的官方能力口径（dotted），不是界面模型域枚举；映射见 mapPresetCapabilitiesToModelCapabilities。 */
export type PresetModelCapability =
  | "llm.chat"
  | "llm.chat.vision"
  | "image.generate"
  | "image.edit"
  | "video.generate"
  | "audio.tts";

export const PRESET_MODEL_CAPABILITIES: readonly PresetModelCapability[] = [
  "llm.chat",
  "llm.chat.vision",
  "image.generate",
  "image.edit",
  "video.generate",
  "audio.tts",
];

export interface PresetModel {
  readonly id: string;
  readonly capabilities: readonly PresetModelCapability[];
}

/** official = 调研拿到的官方清单；catalog = 无公开清单，由 provider/models 动态拉取。 */
export type PresetModelsSource = "official" | "catalog";

export interface ProviderPreset {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly adapterType: string;
  readonly docsUrl: string;
  /** 官方 API Key / 控制台页面；缺失时界面禁用「获取密钥」。 */
  readonly apiKeyUrl?: string;
  readonly credentialMode: PresetCredentialMode;
  readonly models: readonly PresetModel[];
  readonly modelsSource: PresetModelsSource;
  readonly notes: string;
}

/** 单密钥输入框的标签（界面按预设显示，避免把 access_key 当 API Key 填）。 */
export const DUAL_CREDENTIAL_LABELS = { accessKey: "Access Key", secretKey: "Secret Key" } as const;

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: "modelscope",
    name: "ModelScope（魔搭）",
    baseUrl: "https://api-inference.modelscope.cn/v1",
    adapterType: "modelscope",
    docsUrl: "https://www.modelscope.cn/docs/model-service/API-Inference/intro",
    apiKeyUrl: "https://modelscope.cn/my/myaccesstoken",
    credentialMode: "single",
    modelsSource: "official",
    models: [
      { id: "Qwen/Qwen3.8-Flash-Next", capabilities: ["llm.chat", "llm.chat.vision"] },
      { id: "Qwen/Qwen3.5-397B-A17B", capabilities: ["llm.chat"] },
      { id: "deepseek-ai/DeepSeek-V4.1-Flash", capabilities: ["llm.chat"] },
      { id: "MiniMax/MiniMax-M3", capabilities: ["llm.chat"] },
      { id: "Qwen/Qwen-Image-2512", capabilities: ["image.generate"] },
      { id: "Qwen/Qwen-Image-Edit", capabilities: ["image.edit"] },
    ],
    notes: "国内站 /v1，国际站是 .ai 域名，勿混用；GET /v1/models 实测 200。图片是异步任务，无视频端点。",
  },
  {
    id: "agnes",
    name: "Agnes AI",
    baseUrl: "https://apihub.agnes-ai.com/v1",
    adapterType: "agnes",
    docsUrl: "https://agnes-ai.com/en/docs",
    credentialMode: "single",
    modelsSource: "official",
    models: [
      { id: "agnes-2.5-flash", capabilities: ["llm.chat", "llm.chat.vision"] },
      { id: "agnes-image-2.0-flash", capabilities: ["image.generate", "image.edit"] },
      { id: "agnes-video-2.5", capabilities: ["video.generate"] },
    ],
    notes: "OpenAI 兼容，Bearer 鉴权；国内站 https://api.agnes-ai.cn/v1。agnes-2.0-flash 已弃用，用 2.5-flash。",
  },
  {
    id: "lovart",
    name: "Lovart",
    baseUrl: "https://lgw.lovart.ai",
    adapterType: "lovart",
    docsUrl: "https://lovart.notion.site/Lovart-OpenClaw-User-Guide-33da46b16a0f80f6a7fff8e4896b9fca",
    credentialMode: "dual",
    modelsSource: "catalog",
    models: [],
    notes: "非 OpenAI 兼容的 Agent OpenAPI（/v1/openapi/chat），AK/SK HMAC-SHA256 签名鉴权；无公开 /models，模型列表由 catalog 动态拉取。原生协议由另一包实现。",
  },
  {
    id: "volcengine",
    name: "火山引擎（火山方舟 Ark）",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    adapterType: "volcengine",
    docsUrl: "https://ark.volcengine.com/region:cn-beijing/docs/base-url-and-authentication",
    apiKeyUrl: "https://console.volcengine.com/ark",
    credentialMode: "single",
    modelsSource: "official",
    models: [
      { id: "doubao-seed-2-1-pro", capabilities: ["llm.chat", "llm.chat.vision"] },
      { id: "doubao-seed-2-0-pro", capabilities: ["llm.chat", "llm.chat.vision"] },
      { id: "deepseek-v4-pro", capabilities: ["llm.chat"] },
      { id: "doubao-seedream-5-0-pro-260628", capabilities: ["image.generate", "image.edit"] },
      { id: "doubao-seedance-2-5-260628", capabilities: ["video.generate"] },
      { id: "doubao-seed-tts-2-0", capabilities: ["audio.tts"] },
    ],
    notes: "数据面 /api/v3（管控面不同，勿混用）；Bearer API Key。语音走独立的 volcengine-speech 协议。",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    adapterType: "openai-compatible",
    docsUrl: "https://api-docs.deepseek.com/",
    apiKeyUrl: "https://platform.deepseek.com/api_keys",
    credentialMode: "single",
    modelsSource: "official",
    models: [
      { id: "deepseek-flash", capabilities: ["llm.chat", "llm.chat.vision"] },
      { id: "deepseek-v4-pro", capabilities: ["llm.chat"] },
    ],
    notes: "base_url 带不带 /v1 都可以；无图像/视频/音频生成。另有 Anthropic 格式 /anthropic，但这里走 OpenAI 兼容协议。",
  },
  {
    id: "openai",
    name: "GPT（OpenAI）",
    baseUrl: "https://api.openai.com/v1",
    adapterType: "openai-compatible",
    docsUrl: "https://developers.openai.com/api/reference/overview",
    apiKeyUrl: "https://platform.openai.com/api-keys",
    credentialMode: "single",
    modelsSource: "official",
    models: [
      { id: "gpt-6-astra", capabilities: ["llm.chat", "llm.chat.vision"] },
      { id: "gpt-6.1-sol", capabilities: ["llm.chat", "llm.chat.vision"] },
      { id: "gpt-6-luna", capabilities: ["llm.chat"] },
      { id: "gpt-image-2.5-sunburst", capabilities: ["image.generate", "image.edit"] },
      { id: "gpt-4o-mini-tts", capabilities: ["audio.tts"] },
    ],
    notes: "Videos API / Sora 2 已于 2026-09-24 下线（/v1/videos 实测 404），不要再配视频能力。",
  },
  {
    id: "gemini",
    name: "Gemini（Google）",
    baseUrl: "https://generativelanguage.googleapis.com",
    adapterType: "gemini",
    docsUrl: "https://ai.google.dev/gemini-api/docs/openai",
    apiKeyUrl: "https://aistudio.google.com/app/apikey",
    credentialMode: "single",
    modelsSource: "official",
    models: [
      { id: "gemini-3.8-flash", capabilities: ["llm.chat", "llm.chat.vision"] },
      { id: "gemini-3.1-pro-preview", capabilities: ["llm.chat", "llm.chat.vision"] },
      { id: "gemini-3.1-flash-image", capabilities: ["image.generate", "image.edit"] },
      { id: "veo-3.1-generate-preview", capabilities: ["video.generate"] },
    ],
    notes: "原生路径都在 /v1beta 下（generateContent / predictLongRunning）；鉴权用 x-goog-api-key，模型列表走 /v1beta/models。",
  },
  {
    id: "anthropic",
    name: "Claude（Anthropic）",
    baseUrl: "https://api.anthropic.com",
    adapterType: "anthropic",
    docsUrl: "https://platform.claude.com/docs/en/api/messages",
    apiKeyUrl: "https://console.anthropic.com/settings/keys",
    credentialMode: "single",
    modelsSource: "official",
    models: [
      { id: "claude-opus-5-5", capabilities: ["llm.chat", "llm.chat.vision"] },
      { id: "claude-sonnet-5-5", capabilities: ["llm.chat", "llm.chat.vision"] },
      { id: "claude-haiku-5-5", capabilities: ["llm.chat", "llm.chat.vision"] },
      { id: "claude-fable-5-1", capabilities: ["llm.chat", "llm.chat.vision"] },
    ],
    notes: "官方 Messages 协议（POST /v1/messages，x-api-key + anthropic-version）；不走 OpenAI 兼容层。无图像/视频/音频生成。",
  },
];

/** 预设 id → 预设；未知返回 null。 */
export function presetById(id: unknown): ProviderPreset | null {
  const key = String(id == null ? "" : id).trim().toLowerCase();
  return PROVIDER_PRESETS.find((preset) => preset.id === key) || null;
}

/** adapterType → 镜像桥 provider-protocol id（与 electron/model-provider-bridge.cjs#mapProtocol 同口径）。 */
export function presetProtocolId(adapterType: unknown): string {
  const id = String(adapterType == null ? "" : adapterType).trim().toLowerCase();
  if (!id || id === "openai-compatible" || id === "openai") return "openai";
  return id;
}

/** 预设自己的协议 id（= presetProtocolId(preset.adapterType)）。 */
export function providerPresetProtocolId(preset: ProviderPreset): string {
  return presetProtocolId(preset.adapterType);
}

/** 调研的 dotted 能力 → 模型域能力枚举（electron/model-domain.cjs#CAPABILITIES）。
 *  音频能力在模型域没有枚举，如实落到 []（不硬塞）；图片编辑归 image-generation。 */
export function mapPresetCapabilitiesToModelCapabilities(capabilities: unknown): string[] {
  const out: string[] = [];
  const add = (value: string) => { if (value && !out.includes(value)) out.push(value); };
  for (const raw of Array.isArray(capabilities) ? capabilities : []) {
    switch (String(raw)) {
      case "llm.chat": add("chat"); break;
      case "llm.chat.vision": add("chat"); add("vision-input"); break;
      case "image.generate":
      case "image.edit": add("image-generation"); break;
      case "video.generate": add("video-generation"); break;
      default: break;
    }
  }
  return out;
}

/** 预设的推荐模型能力并集（模型域枚举），用于「推荐模型」提示与后续注册。 */
export function presetModelCapabilities(preset: ProviderPreset): string[] {
  return mapPresetCapabilitiesToModelCapabilities(preset.models.flatMap((model) => [...model.capabilities]));
}

/** 协议可用性：available = protocol/list 里有；pending = 没有（另一包还没落地）；unknown = 拿不到协议表。 */
export type PresetProtocolStatus = "available" | "pending" | "unknown";

export function presetProtocolStatus(
  preset: ProviderPreset | null | undefined,
  knownProtocolIds: readonly string[] | null | undefined,
): PresetProtocolStatus {
  if (!preset) return "unknown";
  if (!Array.isArray(knownProtocolIds)) return "unknown";
  const known = new Set(knownProtocolIds.map((id) => String(id == null ? "" : id).trim().toLowerCase()));
  return known.has(providerPresetProtocolId(preset)) ? "available" : "pending";
}

/** 预设选中后要写进表单的字段（名称 / 地址 / 协议 / 凭据形态）；不落库、不建 provider。 */
export function presetDraftPatch(preset: ProviderPreset): {
  displayName: string;
  baseUrl: string;
  adapterType: string;
  credentialMode: PresetCredentialMode;
} {
  return { displayName: preset.name, baseUrl: preset.baseUrl, adapterType: preset.adapterType, credentialMode: preset.credentialMode };
}

/* ── 双密钥（Lovart） ── */

export interface DualCredential {
  accessKey: string;
  secretKey: string;
}

/** 组合成写进凭据后端的单个 JSON 字符串；两把都空返回 ""（= 不写凭据）。 */
export function combineDualCredential(credential: Partial<DualCredential> | null | undefined): string {
  const accessKey = String(credential && credential.accessKey != null ? credential.accessKey : "").trim();
  const secretKey = String(credential && credential.secretKey != null ? credential.secretKey : "").trim();
  if (!accessKey && !secretKey) return "";
  return JSON.stringify({ accessKey, secretKey });
}

/** 反向解析（只用于校验与测试；界面不回显已保存的密钥）。非法 JSON / 形状不符返回 null。 */
export function parseDualCredential(secret: unknown): DualCredential | null {
  const raw = String(secret == null ? "" : secret).trim();
  if (!raw || raw[0] !== "{") return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return null;
    const accessKey = typeof parsed.accessKey === "string" ? parsed.accessKey : "";
    const secretKey = typeof parsed.secretKey === "string" ? parsed.secretKey : "";
    if (!accessKey && !secretKey) return null;
    return { accessKey, secretKey };
  } catch {
    return null;
  }
}

/** 双密钥字段校验：填一把没填另一把 = 不完整（与单密钥「留空表示不更换」不冲突）。 */
export function dualCredentialFieldError(credential: Partial<DualCredential> | null | undefined): string | null {
  const accessKey = String(credential && credential.accessKey != null ? credential.accessKey : "").trim();
  const secretKey = String(credential && credential.secretKey != null ? credential.secretKey : "").trim();
  if (!accessKey && !secretKey) return null;
  if (!accessKey || !secretKey) return "两把密钥要一起填写（access_key 与 secret_key）";
  return null;
}
