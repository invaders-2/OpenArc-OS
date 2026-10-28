/**
 * 「拉取模型 → 四类分类」纯逻辑（无 DOM / 无网络）。
 *
 * 能力事实分层（如实，不为凑四类而编能力）：
 *   · 模型域真实能力枚举（electron/model-domain.cjs:8 CAPABILITIES）：
 *       chat / tool-calling / vision-input / image-generation / video-generation /
 *       audio-generation / 3d-generation / embedding。
 *   · 因此：文本模型 = chat（tool-calling / vision-input 归入文本组并逐项标注）；
 *           图像模型 = image-generation；视频模型 = video-generation；音频模型 = audio-generation；
 *           协议域明确声明 audio.*（如 audio.tts）时也归入音频组。
 *   · 推断不出四类能力的模型一律进「未识别」，不硬塞进任何一组。
 *
 * 分类依据优先用既有推断：
 *   · provider/models 返回的 suggestedCapabilities（后端 electron/provider-adapter.cjs guessCapabilities 按名推断）；
 *   · 缺失时才回落到本模块镜像的 guessCapabilities；inferModelType 只用于「未识别」行的原因说明。
 *   两条镜像规则由 tests/dxos-model-settings-ui.test.mjs 对着 electron/*.cjs 做防漂移核对。
 */

export type RemoteGroupId = "text" | "image" | "video" | "audio" | "unknown";

export const MODEL_CAPABILITIES = ["chat", "tool-calling", "vision-input", "image-generation", "video-generation", "audio-generation", "3d-generation", "embedding"] as const;

export const CAPABILITY_LABEL: Record<string, string> = {
  chat: "文本对话",
  "tool-calling": "工具调用",
  "vision-input": "图片输入",
  "image-generation": "生图",
  "video-generation": "视频生成",
  "audio-generation": "音频生成",
  "3d-generation": "3D 生成",
  embedding: "向量",
};

export const CAPABILITY_SHORT: Record<string, string> = {
  chat: "对话",
  "tool-calling": "工具",
  "vision-input": "看图",
  "image-generation": "生图",
  "video-generation": "视频",
  "audio-generation": "音频",
  "3d-generation": "3D",
  embedding: "向量",
};

export interface RemoteModelItem {
  id: string;
  ownedBy?: string | null;
  /** provider/models 的推断结果；缺省（undefined）时才回落到本地镜像。显式 [] 表示后端判定「无能力」。 */
  suggestedCapabilities?: string[] | null;
  registered?: boolean;
  /** 协议域声明的意图（如 audio.tts）；provider/models 不返回，保留给协议域接入时使用。 */
  protocolIntents?: string[] | null;
}

export interface ClassifiedRemoteModel {
  id: string;
  ownedBy: string | null;
  registered: boolean;
  group: RemoteGroupId;
  capabilities: string[];
  coarseType: string;
  reasons: string[];
}

export const REMOTE_GROUP_ORDER: RemoteGroupId[] = ["text", "image", "video", "audio", "unknown"];

export const REMOTE_GROUP_META: Record<RemoteGroupId, { label: string; note: string; emptyText: string }> = {
  text: {
    label: "文本模型",
    note: "模型域能力含 chat；tool-calling / vision-input 一并归入本组，并在每行逐项标注。",
    emptyText: "上游清单里没有文本模型",
  },
  image: { label: "图像模型", note: "模型域能力含 image-generation。", emptyText: "上游清单里没有图像模型" },
  video: { label: "视频模型", note: "模型域能力含 video-generation。", emptyText: "上游清单里没有视频模型" },
  audio: {
    label: "音频模型",
    note: "模型域能力含 audio-generation；协议域明确声明 audio.*（如 audio.tts）时也归入本组。",
    emptyText: "上游清单里没有音频模型",
  },
  unknown: {
    label: "未识别",
    note: "推断不出四类能力，或推断到的能力不属于四类（如 embedding）。如实展示，不硬塞进任何一组。",
    emptyText: "没有未识别的模型",
  },
};

export const REMOTE_CLASSIFY_NOTE =
  "分类依据 provider/models 返回的 suggestedCapabilities（后端由 guessCapabilities 按模型名推断，只作勾选默认值，不等于已验证）。" +
  "多能力模型的归组优先级：图像 > 视频 > 文本。";

/** 与 electron/provider-adapter.cjs:185-193 guessCapabilities 逐条一致（单测做防漂移核对）。 */
export function guessCapabilitiesFromId(id: unknown): string[] {
  const s = String(id == null ? "" : id).toLowerCase();
  if (/(image|dall-?e|flux|seedream|stable-?diffusion|sdxl|midjourney|imagen|cogview|wanx|kolors|gpt-image)/.test(s)) return ["image-generation"];
  if (/(video|seedance|kling|veo|sora|hailuo|wan2|cogvideo|vidu)/.test(s)) return ["video-generation"];
  if (/(suno|lyria|flowmusic|mureka|udio|music|(^|[-_/])tts|text-to-speech|sound-?effect)/.test(s) && !/(whisper|transcri|audio-preview|realtime)/.test(s)) return ["audio-generation"];
  if (/(embed|rerank|whisper|tts|speech|audio|moderation)/.test(s)) return [];
  const caps = ["chat"];
  if (/(vl|vision|4o|4\.1|gpt-5|gemini|claude|qwen-?vl|glm-4v|o3|o4)/.test(s)) caps.push("vision-input");
  return caps;
}

const COARSE_VIDEO = /(?:^|[-_/])(?:sora|veo|kling|pixverse|pika|vidu|wan|seedance|hailuo|minimax-h3)/i;
const COARSE_IMAGE = /(?:^|[-_/])(?:dall-e|gpt-image|seedream|flux|midjourney|imagen|sd-?d|kolors|ideogram|banana|cogview)/i;
const COARSE_AUDIO = /(?:tts|whisper|speech|voice|audio|music|suno|udio)/i;

/** 与 electron/model-manifest-domain.cjs:288-298 inferModelType 同规则（单测防漂移）。 */
export function inferModelCoarseType(id: unknown): { type: string; reasons: string[] } {
  const name = String(id == null ? "" : id);
  if (COARSE_VIDEO.test(name)) return { type: "video", reasons: ["命中视频模型名规则"] };
  if (COARSE_IMAGE.test(name)) return { type: "image", reasons: ["命中图像模型名规则"] };
  if (COARSE_AUDIO.test(name)) return { type: "audio", reasons: ["命中音频模型名规则"] };
  if (/(?:embed|rerank|bge-|text-embedding)/i.test(name)) return { type: "other", reasons: ["命中向量模型名规则"] };
  return { type: "llm", reasons: ["未命中特殊模型名规则，按语言模型处理"] };
}

export function normalizeModelCapabilities(list: unknown): string[] {
  const out: string[] = [];
  if (!Array.isArray(list)) return out;
  for (const item of list) {
    const value = String(item == null ? "" : item);
    if ((MODEL_CAPABILITIES as readonly string[]).includes(value) && !out.includes(value)) out.push(value);
  }
  return out;
}

function modelDomainCapabilities(input: RemoteModelItem): string[] {
  if (Array.isArray(input.suggestedCapabilities)) return normalizeModelCapabilities(input.suggestedCapabilities);
  return normalizeModelCapabilities(guessCapabilitiesFromId(input.id));
}

/**
 * 单个模型 → 四类之一（或未识别）。
 * 优先级：image-generation > video-generation > chat > 协议域 audio.* > 未识别。
 */
export function classifyRemoteModel(input: RemoteModelItem): ClassifiedRemoteModel {
  const source = input && typeof input === "object" ? input : ({ id: String(input == null ? "" : input) } as RemoteModelItem);
  const id = String(source.id == null ? "" : source.id);
  const capabilities = modelDomainCapabilities({ ...source, id });
  const coarse = inferModelCoarseType(id);
  const intents = Array.isArray(source.protocolIntents) ? source.protocolIntents.map((x) => String(x)) : [];
  const audioIntents = intents.filter((x) => x === "audio" || x.startsWith("audio."));
  const reasons: string[] = [];
  let group: RemoteGroupId;

  if (capabilities.includes("image-generation")) {
    group = "image";
    reasons.push("模型域能力含 image-generation");
  } else if (capabilities.includes("video-generation")) {
    group = "video";
    reasons.push("模型域能力含 video-generation");
  } else if (capabilities.includes("chat")) {
    group = "text";
    const extra = capabilities.filter((c) => c !== "chat");
    reasons.push("模型域能力含 chat" + (extra.length ? "（同时含 " + extra.join("、") + "）" : ""));
  } else if (capabilities.includes("audio-generation")) {
    group = "audio";
    reasons.push("模型域能力含 audio-generation");
  } else if (audioIntents.length) {
    group = "audio";
    reasons.push("协议域声明了 " + audioIntents.join("、"));
  } else {
    group = "unknown";
    if (coarse.type === "audio") {
      reasons.push("模型名命中音频规则（" + coarse.reasons.join("；") + "），但模型域没有音频能力枚举，且协议域未声明 audio.*；不硬塞进音频组");
    } else if (coarse.type === "other") {
      reasons.push("模型名命中向量规则（" + coarse.reasons.join("；") + "）；embedding 不属于四类");
    } else if (capabilities.length) {
      reasons.push("推断到的能力（" + capabilities.join("、") + "）不属于四类");
    } else {
      reasons.push("模型域与协议域都推断不出四类能力");
    }
  }

  return {
    id,
    ownedBy: source.ownedBy != null ? String(source.ownedBy) : null,
    registered: source.registered === true,
    group,
    capabilities,
    coarseType: coarse.type,
    reasons,
  };
}

export interface RemoteModelGroup {
  id: RemoteGroupId;
  label: string;
  note: string;
  emptyText: string;
  items: ClassifiedRemoteModel[];
}

export interface RemoteModelGrouping {
  groups: RemoteModelGroup[];
  counts: Record<RemoteGroupId, number>;
  total: number;
}

/** 把 provider/models 的 items 分成四类 + 未识别；query 只按模型 id 过滤（与既有筛选一致）。 */
export function groupRemoteModels(items: unknown, options: { query?: string } = {}): RemoteModelGrouping {
  const list = Array.isArray(items) ? items : [];
  const query = String(options.query == null ? "" : options.query).trim().toLowerCase();
  const groups: RemoteModelGroup[] = REMOTE_GROUP_ORDER.map((id) => ({ id, ...REMOTE_GROUP_META[id], items: [] }));
  const byId = new Map<RemoteGroupId, RemoteModelGroup>(groups.map((g) => [g.id, g]));
  let total = 0;
  for (const raw of list) {
    if (!raw || typeof raw !== "object" || raw.id == null || String(raw.id) === "") continue;
    const classified = classifyRemoteModel(raw as RemoteModelItem);
    if (query && !classified.id.toLowerCase().includes(query)) continue;
    total += 1;
    const group = byId.get(classified.group);
    if (group) group.items.push(classified);
  }
  const counts = Object.fromEntries(groups.map((g) => [g.id, g.items.length])) as Record<RemoteGroupId, number>;
  return { groups, counts, total };
}
