/**
 * 画布数据模型。
 *
 * 持久化仍走现有的 CanvasDoc（react-canvas/reactCanvasStore.ts）：节点的通用字段（kind/x/y/w/h/text/url）不变，
 * 生成相关的一切（标题、提示词、参数、历史版本、输入顺序、标记）放在 node.data.gen 里。
 * 这样 persistence / 协作 / 迁移 / 资源引用 这些既有模块原样可用，旧画布打开时按 genOf() 补默认值。
 *
 * 运行态（生成中、进度、runId、错误）不进文档，见 store.ts 的 runtime。
 */
import type { CanvasDoc, CanvasEdge, CanvasNode, NodeKind } from "../react-canvas/reactCanvasStore";

export type GenKind = "text" | "image" | "video" | "audio";
export const GEN_KINDS: GenKind[] = ["text", "image", "video", "audio"];
export const isGenKind = (k: NodeKind | string): k is GenKind => k === "text" || k === "image" || k === "video" || k === "audio";

export const TYPE_LABEL: Record<GenKind, string> = { image: "图片", video: "视频", text: "文本", audio: "音频" };
export const TYPE_ICON = { image: "image", video: "video", text: "text", audio: "audio" } as const;

/* ---------- 参数 ---------- */
export type CameraParams = { on: boolean; body: number; lens: number; focal: number; aperture: number };
export type ImageParams = { model: string; ratio: string; size: string; count: number; search: boolean; style: string; camera: CameraParams };
export type VideoMode = "文生视频" | "首帧" | "首尾帧" | "参考生视频" | "视频编辑" | "视频延长" | "参考视频生视频" | "数字人";
export type VideoParams = { model: string; mode: VideoMode; ratio: string; res: string; dur: number; sound: boolean; times: number; /** 多镜头（高级设置） */ multiShot?: boolean };
export type TextParams = { model: string; search: boolean; /** 输出：文本 / 多维表格 / 分镜表 */ output?: "text" | "table" | "storyboard" };
export type AudioParams = { model: string; kind: string; dur: string };
export type ParamsOf<K extends GenKind> = K extends "image" ? ImageParams : K extends "video" ? VideoParams : K extends "text" ? TextParams : AudioParams;
export type AnyParams = ImageParams | VideoParams | TextParams | AudioParams;

/** 一次生成的产物。图片 / 视频 / 音频是地址，文本是正文。 */
export type GenOutput = {
  url?: string;
  /** 视频的封面帧（可选） */
  frame?: string;
  text?: string;
  w?: number;
  h?: number;
  dur?: number;
  res?: string;
  /** 音频波形（0~1），后端不给时前端从音频解码或用占位 */
  bars?: number[];
  meta?: { model?: string; ratio?: string; size?: string; at?: number; runId?: string; remote?: string };
};

export type GenData = {
  title: string;
  prompt: string;
  params: AnyParams;
  hist: GenOutput[];
  hi: number;
  /** 入边顺序（edge id），决定发给模型的输入顺序 */
  order: string[];
  pinned?: boolean;
  /** 节点背景色（TapNow「背景颜色」：NODE_BG 的键） */
  bg?: string;
  /** 颜色标签（TapNow「Pin」：NODE_TAG 的键）；旧数据 pinned=true 视为红色 */
  tag?: string;
  fav?: boolean;
  /** 由 Agent 新建 */
  agent?: boolean;
  /** 文本节点：手写内容（不需要生成） */
  manual?: boolean;
  /** 图片节点：用户上传 */
  uploaded?: boolean;
  /** 最近一次失败的说明（持久化，刷新后仍能看到） */
  err?: string;
};

/* ---------- 模型能力 ---------- */
export type ModelSpec = {
  id: string; // configId
  name: string;
  vendor: string;
  tags: string[];
  kind: GenKind;
  local?: boolean;
  secs: number; // 估计耗时（秒）
  // image
  ratios?: string[]; sizes?: string[]; maxRefs?: number; i2i?: boolean; search?: boolean; style?: boolean; camera?: boolean; batch?: number[];
  // video
  modes?: VideoMode[]; res?: string[]; durs?: number[]; audio?: boolean; times?: number[]; multiShot?: boolean;
  // text
  vision?: boolean;
  // audio
  kinds?: string[]; adurs?: string[];
  /**
   * 规格来源：`spec` = 后端适配器给了 uiSpec（以它为准）；`guess` = 没规格，按模型名套 PRESETS 兜底（面板显示「未验证」）。
   * 可选能力（联网 / 风格 / 摄影机 / 批量 / 参考图上限）只在 spec 里出现才算支持。
   */
  specSource?: "spec" | "guess";
};

/** TapNow 视频 modelType 全集：中文名 → 接口值 + 需要的输入 */
export const VMODES: Record<VideoMode, { api: string; need: string }> = {
  "文生视频": { api: "text_to_video", need: "不用图片，只靠提示词" },
  "首帧": { api: "image_to_video", need: "第 1 张图作为开场画面" },
  "首尾帧": { api: "start_end_to_video", need: "第 1、2 张图分别是首帧和尾帧" },
  "参考生视频": { api: "reference_to_video", need: "多张图作主体 / 风格参考" },
  "视频编辑": { api: "video_edit", need: "连入 1 段视频，用提示词改它" },
  "视频延长": { api: "video_extend", need: "连入 1 段视频，接着往后生成" },
  "参考视频生视频": { api: "reference_video_to_video", need: "连入视频作动作 / 运镜参考" },
  "数字人": { api: "digital_human", need: "1 张人像 + 1 段音频，生成口播" },
};

export const STYLES: Array<[string, string]> = [["无", "var(--s2)"], ["电影感", "linear-gradient(#000 0 12%,#24404a 12% 88%,#000 88%)"], ["胶片", "linear-gradient(135deg,#6b4a2f,#c79a6a)"], ["极简棚拍", "linear-gradient(#f3f3f3,#cfcfd4)"], ["赛博", "linear-gradient(135deg,#3b0a5c,#0ff3)"], ["水彩", "linear-gradient(135deg,#f6c1c9,#b8e0f6)"], ["3D 渲染", "radial-gradient(circle at 30% 30%,#fff,#777 60%,#222)"], ["国潮", "linear-gradient(135deg,#7a0d0d,#e2b84d)"]];
export const CAMERAS = { body: ["Sony Venice", "ARRI Alexa 35", "RED V-Raptor", "iPhone 17 Pro"], lens: ["Zeiss Ultra Prime", "Cooke S7/i", "Canon K35"], focal: [8, 14, 24, 35, 50, 75, 125], aperture: ["ƒ/1.4", "ƒ/2", "ƒ/2.8", "ƒ/4", "ƒ/8"] };

/**
 * 风格取值收敛到 STYLES 枚举。
 *
 * 后端只把 style 当 ≤40 字自由文本原样拼进提示词，所以画布这边必须保证：
 *   · 只有 STYLES 里的名字才会被发送；
 *   · 未知 / 自定义串一律不发送（styleForRequest → null），绝不把脏字符串塞进请求；
 *   · 清空 / 「无」/ 非法值在读参数时回退成「无」（normalizeStyle）。
 */
const STYLE_NAMES = new Set(STYLES.map(([name]) => name));
/** 文档/面板里的风格 → 合法枚举值（未知一律回退「无」） */
export function normalizeStyle(style: unknown): string {
  const value = String(style == null ? "" : style).trim();
  return STYLE_NAMES.has(value) ? value : "无";
}
/** 发请求用的风格：只有 STYLES 里的非「无」值才返回，其它一律 null（这一条请求不带风格） */
export function styleForRequest(style: unknown): string | null {
  const value = normalizeStyle(style);
  return value === "无" ? null : value;
}

/**
 * 已知模型的能力表（按名字匹配）。后端 canvas/models 只给 configId / 名称 / capabilities，
 * 比例、分辨率、生成方式这些前端控件靠这张表决定；匹配不到的模型用同类型的保守默认值。
 */
const PRESETS: Array<{ re: RegExp; spec: Partial<ModelSpec> & { kind: GenKind } }> = [
  { re: /banana|gemini.*image|nano/i, spec: { kind: "image", tags: ["4K"], ratios: ["自适应", "1:1", "9:16", "16:9", "3:4", "4:3", "3:2", "2:3", "5:4", "4:5", "21:9"], sizes: ["1K", "2K", "4K"], maxRefs: 14, i2i: true, search: true, style: true, camera: true, batch: [1, 2, 4], secs: 12 } },
  { re: /seedream/i, spec: { kind: "image", tags: ["2K"], ratios: ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9"], sizes: ["2K", "3K"], maxRefs: 14, i2i: true, batch: [1, 2, 4], secs: 9 } },
  { re: /gpt.?image|dall/i, spec: { kind: "image", tags: ["4K"], ratios: ["auto", "1:1", "2:1", "4:3", "3:4", "5:4", "4:5", "3:2", "2:3", "16:9", "9:16", "21:9", "9:21"], sizes: ["1K", "2K", "4K"], maxRefs: 16, i2i: true, batch: [1, 2, 4], secs: 14 } },
  { re: /flux/i, spec: { kind: "image", tags: ["2K"], ratios: ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3"], sizes: ["1K", "2K"], maxRefs: 4, i2i: true, batch: [1, 2, 4], secs: 8 } },
  { re: /midjourney|\bmj\b/i, spec: { kind: "image", tags: ["2K"], ratios: ["1:1", "16:9", "9:16", "4:3", "3:4", "2:3", "3:2", "7:4", "4:7"], sizes: ["2K"], maxRefs: 4, i2i: true, batch: [4], secs: 16 } },
  { re: /recraft/i, spec: { kind: "image", tags: ["矢量"], ratios: ["1:1", "4:3", "3:4", "16:9", "9:16"], sizes: ["1080P"], maxRefs: 0, i2i: false, batch: [1, 2], secs: 7 } },
  { re: /sdxl|comfy|stable/i, spec: { kind: "image", tags: ["本机"], ratios: ["1:1", "4:3", "3:4", "16:9", "9:16"], sizes: ["1K"], maxRefs: 1, i2i: true, batch: [1, 2, 4], secs: 6, local: true } },
  { re: /seedance/i, spec: { kind: "video", tags: ["1080P"], modes: ["文生视频", "首帧", "首尾帧", "参考生视频", "视频编辑", "视频延长"], ratios: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"], res: ["480p", "720p", "1080p"], durs: [5, 10, 15], maxRefs: 9, times: [1, 2, 4], audio: true, secs: 120 } },
  { re: /veo/i, spec: { kind: "video", tags: ["有声"], modes: ["文生视频", "首帧", "首尾帧", "参考生视频", "视频延长"], ratios: ["16:9", "9:16"], res: ["720p", "1080p"], durs: [4, 6, 8], maxRefs: 3, audio: true, times: [1, 2], secs: 120 } },
  { re: /kling|可灵/i, spec: { kind: "video", tags: ["热门"], modes: ["文生视频", "首帧", "首尾帧", "参考生视频", "参考视频生视频", "数字人"], ratios: ["16:9", "9:16", "1:1"], res: ["720p", "1080p"], durs: [5, 10], maxRefs: 4, times: [1, 2], secs: 120 } },
  { re: /hailuo|minimax.*video|wan|runway|sora|pika|vidu/i, spec: { kind: "video", tags: [], modes: ["文生视频", "首帧", "首尾帧"], ratios: ["16:9", "9:16", "1:1"], res: ["720p", "1080p"], durs: [5, 10], maxRefs: 2, times: [1], secs: 120 } },
  { re: /mureka|suno|music/i, spec: { kind: "audio", tags: ["音乐"], kinds: ["音乐", "配音", "音效"], adurs: ["自适应", "15s", "30s", "60s"], secs: 10 } },
  { re: /eleven|tts|speech|voice/i, spec: { kind: "audio", tags: ["配音"], kinds: ["配音", "音效"], adurs: ["自适应", "15s", "30s"], secs: 8 } },
];
const DEFAULTS: Record<GenKind, Partial<ModelSpec>> = {
  image: { ratios: ["1:1", "3:4", "4:3", "16:9", "9:16"], sizes: ["1K", "2K"], maxRefs: 4, i2i: true, batch: [1, 2, 4], secs: 12 },
  video: { modes: ["文生视频", "首帧", "首尾帧"], ratios: ["16:9", "9:16", "1:1"], res: ["720p"], durs: [5, 10], maxRefs: 2, times: [1], secs: 120 },
  text: { vision: false, search: false, secs: 4 },
  audio: { kinds: ["音乐", "配音", "音效"], adurs: ["自适应", "15s", "30s"], secs: 10 },
};
/** 后端模型行 → 前端能力表。kind 由 capabilities 决定，能力细节按名字套预设。 */
/** 服务商适配器给的面板规格（canvas/models 的 uiSpec）里，前端认的字段 */
const UI_KEYS = ["ratios", "sizes", "batch", "maxRefs", "i2i", "res", "durs", "modes", "audio", "times", "kinds", "adurs", "search", "style", "camera", "multiShot"] as const;
function fromProvider(kind: GenKind, ui?: Record<string, unknown> | null): Partial<ModelSpec> {
  if (!ui || typeof ui !== "object" || (ui.kind && ui.kind !== kind)) return {};
  const out: Record<string, unknown> = {};
  for (const k of UI_KEYS) if (ui[k] !== undefined && ui[k] !== null) out[k] = ui[k];
  if (Array.isArray(out.modes)) out.modes = (out.modes as string[]).filter((m) => m in VMODES);
  const top = kind === "image" ? (out.sizes as string[] | undefined)?.slice(-1)[0] : kind === "video" ? (out.res as string[] | undefined)?.slice(-1)[0]?.toUpperCase() : undefined;
  if (top) out.tags = [top];
  // 估计耗时（进度条用）：服务商规格没给时按类型估，视频生成通常要两分钟上下
  out.secs = typeof ui.secs === "number" && ui.secs > 0 ? ui.secs : kind === "video" ? 120 : kind === "audio" ? 30 : kind === "image" ? 15 : 8;
  return out as Partial<ModelSpec>;
}

/**
 * 后端模型行 → 前端能力表。kind 由 capabilities 决定。
 *
 * **规格优先**：canvas/models 行带了服务商适配器的 uiSpec（specSource='spec'）就以它为准，
 * 名字 PRESETS 一个字段都不继承 —— 按名字匹配会把别家的「联网 / 风格 / 摄影机 / 批量 / 参考图上限」
 * 套过来，服务端根本不支持却显示成可用（"假可用"）。
 * 没有 uiSpec 时才用 PRESETS 兜底，并把 specSource 标成 'guess'，面板据此显示「未验证」。
 */
export function specFor(row: { configId: string; label: string; vendor?: string; kind: GenKind; local?: boolean; vision?: boolean; search?: boolean; ui?: Record<string, unknown> | null; specSource?: string }): ModelSpec {
  const prov = fromProvider(row.kind, row.ui);
  const hasSpec = Object.keys(prov).length > 0;
  const preset = hasSpec ? {} : PRESETS.find((p) => p.spec.kind === row.kind && p.re.test(row.label))?.spec || {};
  // 有规格时：可选能力只认规格里明确的声明，规格没写就是「不支持」（不再从名字继承，也不回落猜测）。
  // 比例 / 档位 / 时长这类**必填取值**缺省时仍按同类型通用表兜底（否则面板无从选择），
  // 但 batch / maxRefs / i2i / times / audio / multiShot 这些**可选能力**缺省一律按不支持。
  const base = hasSpec
    ? {
      ...prov,
      search: prov.search === true, style: prov.style === true, camera: prov.camera === true,
      ...(row.kind === "image" ? { batch: prov.batch ?? [1], maxRefs: prov.maxRefs ?? 0, i2i: prov.i2i === true } : {}),
      ...(row.kind === "video" ? { times: prov.times ?? [1], audio: prov.audio === true, multiShot: prov.multiShot === true } : {}),
    }
    : preset;
  // 后端显式给的 specSource 优先，但『标了 spec 却没带可用规格』不许冒充已验证
  const declared = row.specSource === "spec" || row.specSource === "guess" ? row.specSource : null;
  const specSource: "spec" | "guess" = declared === "guess" || (declared === "spec" && !hasSpec) || (!declared && !hasSpec) ? "guess" : "spec";
  return {
    secs: 10, tags: [], ...DEFAULTS[row.kind], ...base,
    id: row.configId, name: row.label, vendor: row.vendor || "", kind: row.kind,
    ...(row.local ? { local: true } : {}),
    specSource,
    // 能读图：能力表（row.vision）是后端声明的，不是名字猜的；联网：规格里有才算，没规格才按名字猜
    ...(row.kind === "text" ? {
      vision: row.vision ?? (hasSpec ? false : /vl|vision|gemini|gpt-4o|gpt-5|claude|qwen.*vl/i.test(row.label)),
      search: typeof prov.search === "boolean" ? prov.search : !hasSpec && (row.search ?? /gemini|search|联网/i.test(row.label)),
    } : {}),
  } as ModelSpec;
}

export function defaultParams(kind: GenKind, m?: ModelSpec): AnyParams {
  const model = m?.id || "";
  if (kind === "image") return { model, ratio: m?.ratios?.includes("3:4") ? "3:4" : m?.ratios?.[0] || "1:1", size: m?.sizes?.includes("2K") ? "2K" : m?.sizes?.[0] || "1K", count: 1, search: false, style: "无", camera: { on: false, body: 0, lens: 0, focal: 2, aperture: 3 } };
  if (kind === "video") return { model, mode: "文生视频", ratio: m?.ratios?.[0] || "16:9", res: m?.res?.includes("720p") ? "720p" : m?.res?.[0] || "720p", dur: m?.durs?.[0] || 5, sound: false, times: 1 };
  if (kind === "text") return { model, search: false, output: "text" };
  return { model, kind: m?.kinds?.[0] || "音乐", dur: m?.adurs?.[0] || "自适应" };
}

/** 档位按数值取最接近（1080p 切到只有 480p/720p 的模型 → 720p，而不是第一个） */
const tierNum = (x: string) => { const s = String(x).toLowerCase(); const k = /([0-9.]+)\s*k/.exec(s); if (k) return Number(k[1]) * 1000; const p = /([0-9]+)\s*p/.exec(s); if (p) return Number(p[1]) * 1.5; const mp = /([0-9.]+)\s*mp/.exec(s); return mp ? Number(mp[1]) * 1000 : NaN; };
const nearestTier = (list: string[], want: string) => { const t = tierNum(want); return Number.isFinite(t) ? list.reduce((a, b) => (Math.abs(tierNum(b) - t) < Math.abs(tierNum(a) - t) ? b : a), list[0]) : list[0]; };

/** 切换模型时把不再支持的参数收回到合法值 */
export function clampParams(kind: GenKind, p: AnyParams, m: ModelSpec): AnyParams {
  if (kind === "image") {
    const q = { ...(p as ImageParams), camera: { ...(p as ImageParams).camera }, model: m.id };
    if (m.ratios && !m.ratios.includes(q.ratio)) q.ratio = m.ratios[0];
    if (m.sizes && m.sizes.length && !m.sizes.includes(q.size)) q.size = nearestTier(m.sizes, q.size);
    if (m.batch && !m.batch.includes(q.count)) q.count = m.batch[0];
    if (!m.search) q.search = false; q.style = m.style ? normalizeStyle(q.style) : "无"; if (!m.camera) q.camera.on = false;
    return q;
  }
  if (kind === "video") {
    const q = { ...(p as VideoParams), model: m.id };
    if (m.ratios && m.ratios.length && !m.ratios.includes(q.ratio)) q.ratio = m.ratios[0];
    if (m.res && m.res.length && !m.res.includes(q.res)) q.res = nearestTier(m.res, q.res);
    if (m.durs && m.durs.length && !m.durs.includes(q.dur)) q.dur = m.durs.reduce((a, b) => (Math.abs(b - q.dur) < Math.abs(a - q.dur) ? b : a), m.durs[0]);
    if (m.modes && m.modes.length && !m.modes.includes(q.mode)) q.mode = m.modes[0];
    if (!(m.times || [1]).includes(q.times || 1)) q.times = 1;
    if (!m.audio) q.sound = false;
    if (!m.multiShot) q.multiShot = false;
    return q;
  }
  if (kind === "text") { const q = { ...(p as TextParams), model: m.id }; if (!m.search) q.search = false; return q; }
  const q = { ...(p as AudioParams), model: m.id }; if (m.kinds && m.kinds.length && !m.kinds.includes(q.kind)) q.kind = m.kinds[0]; if (m.adurs && m.adurs.length && !m.adurs.includes(q.dur)) q.dur = m.adurs[0]; return q;
}

/* ---------- 节点读写 ---------- */
export const NODE_DEFAULT_SIZE: Record<GenKind, { w: number; h: number }> = { text: { w: 280, h: 200 }, image: { w: 240, h: 240 }, video: { w: 320, h: 180 }, audio: { w: 320, h: 120 } };

/** 读节点的生成数据；旧画布的节点没有 data.gen，按通用字段补出来（不改原节点）。 */
export function genOf(node: CanvasNode): GenData {
  const raw = (node.data && typeof node.data === "object" ? (node.data as { gen?: Partial<GenData> }).gen : undefined) || {};
  const kind = isGenKind(node.kind) ? node.kind : "text";
  let hist = Array.isArray(raw.hist) ? raw.hist.filter(Boolean) as GenOutput[] : [];
  if (!hist.length) {
    if (kind === "text" && node.text) hist = [{ text: node.text }];
    else if (node.url) hist = [node.kind === "video" ? { url: node.url } : { url: node.url }, ...(node.variants || []).map((u) => ({ url: u }))];
  }
  // 旧文档可能存着自定义风格串：读参数时就收敛到 STYLES，避免「面板显示一个名字、请求里又发不出去」
  const rawParams = (raw.params as AnyParams) || defaultParams(kind);
  const params = kind === "image" && rawParams && typeof rawParams === "object"
    ? { ...rawParams, style: normalizeStyle((rawParams as ImageParams).style) }
    : rawParams;
  return {
    title: typeof raw.title === "string" && raw.title ? raw.title : TYPE_LABEL[kind],
    prompt: typeof raw.prompt === "string" ? raw.prompt : (kind !== "text" && !node.url ? node.text || "" : ""),
    params,
    hist,
    hi: Math.min(Math.max(0, Number(raw.hi) || 0), Math.max(0, hist.length - 1)),
    order: Array.isArray(raw.order) ? raw.order.filter((x): x is string => typeof x === "string") : [],
    ...(raw.pinned ? { pinned: true } : {}), ...(raw.fav ? { fav: true } : {}), ...(raw.agent ? { agent: true } : {}),
    ...(typeof raw.bg === "string" && NODE_BG.some((c) => c[0] === raw.bg) ? { bg: raw.bg } : {}),
    ...(typeof raw.tag === "string" && NODE_TAG.some((c) => c[0] === raw.tag) ? { tag: raw.tag } : raw.pinned ? { tag: "red" } : {}),
    ...(raw.manual ? { manual: true } : {}), ...(raw.uploaded ? { uploaded: true } : {}), ...(raw.err ? { err: String(raw.err) } : {}),
  };
}
/** 节点背景色（TapNow 背景颜色面板：无色 + 7 种低饱和色） */
export const NODE_BG: Array<[string, string]> = [["red", "#8e4545"], ["orange", "#8a5426"], ["olive", "#8a8231"], ["green", "#4b7744"], ["teal", "#3d6f7c"], ["blue", "#34508a"], ["purple", "#78408e"]];
/** 颜色标签（TapNow Pin：6 种亮色） */
export const NODE_TAG: Array<[string, string]> = [["red", "#e25c5c"], ["orange", "#eda05a"], ["yellow", "#e9c85a"], ["green", "#6cc67c"], ["blue", "#5aa1f0"], ["purple", "#9b6ae6"]];
export const bgColor = (key?: string) => NODE_BG.find((c) => c[0] === key)?.[1] || null;
export const tagColor = (key?: string) => NODE_TAG.find((c) => c[0] === key)?.[1] || null;
export const outOf = (node: CanvasNode): GenOutput | null => { const g = genOf(node); return g.hist[g.hi] || null; };
export const srcOf = (node: CanvasNode): string => { const o = outOf(node); return node.kind === "video" ? o?.frame || "" : node.kind === "image" ? o?.url || "" : ""; };
export const textOf = (node: CanvasNode): string => (node.kind === "text" ? outOf(node)?.text || "" : "");

/** 把生成数据写回节点：同时同步通用字段，旧版组件 / 导出 / 资源引用也能读到当前结果 */
export function withGen(node: CanvasNode, patch: Partial<GenData>): CanvasNode {
  const g = { ...genOf(node), ...patch };
  const cur = g.hist[g.hi];
  const next: CanvasNode = { ...node, data: { ...(node.data && typeof node.data === "object" ? node.data : {}), gen: g } };
  if (node.kind === "text") next.text = (cur?.text || "").slice(0, 4000);
  else {
    next.text = g.title;
    if (cur?.url) next.url = cur.url; else delete next.url;
    next.variants = g.hist.filter((o, i) => i !== g.hi && o.url).map((o) => o.url as string).slice(0, 20);
    if (node.kind === "image" || node.kind === "video") { const p = g.params as ImageParams | VideoParams; next.ratio = p.ratio; }
  }
  return next;
}

export function newNode(kind: GenKind, x: number, y: number, extra: Partial<GenData> & { w?: number; h?: number; id?: string } = {}, model?: ModelSpec): CanvasNode {
  const size = NODE_DEFAULT_SIZE[kind];
  const { w, h, id, ...gen } = extra;
  const base: CanvasNode = { id: id || uid("n"), kind, x: Math.round(x), y: Math.round(y), w: w ?? size.w, h: h ?? size.h, text: "" };
  return withGen(base, { title: TYPE_LABEL[kind], prompt: "", params: defaultParams(kind, model), hist: [], hi: 0, order: [], ...gen });
}

/* ---------- 图关系 ---------- */
export type InputRef = { edge: CanvasEdge; node: CanvasNode; order: number };
/** 节点的输入，按 data.gen.order 排序；order 里没有的边排在后面（按边在文档里的顺序） */
export function inputsOf(doc: CanvasDoc, id: string): InputRef[] {
  const n = doc.nodes.find((x) => x.id === id); if (!n) return [];
  const order = genOf(n).order;
  const edges = doc.edges.filter((e) => e.to === id);
  const rank = (e: CanvasEdge) => { const i = order.indexOf(e.id); return i < 0 ? 1e6 + edges.indexOf(e) : i; };
  return edges.slice().sort((a, b) => rank(a) - rank(b)).map((edge, i) => ({ edge, node: doc.nodes.find((x) => x.id === edge.from)!, order: i })).filter((x) => x.node);
}
export const outputsOf = (doc: CanvasDoc, id: string) => doc.edges.filter((e) => e.from === id).map((e) => doc.nodes.find((n) => n.id === e.to)).filter((n): n is CanvasNode => !!n);
export function wouldCycle(doc: CanvasDoc, from: string, to: string): boolean {
  const seen = new Set<string>(); const stack = [to];
  while (stack.length) { const x = stack.pop()!; if (x === from) return true; if (seen.has(x)) continue; seen.add(x); doc.edges.filter((e) => e.from === x).forEach((e) => stack.push(e.to)); }
  return false;
}
/** 能不能从 from 连到 to；不能时返回原因 */
export function connectBlock(doc: CanvasDoc, from: string, to: string): string | null {
  if (from === to) return "不能连到自己";
  if (doc.edges.some((e) => e.from === from && e.to === to)) return "这两个节点已经连着";
  if (wouldCycle(doc, from, to)) return "不能连成环：下游节点不能再作为上游的输入";
  const a = doc.nodes.find((n) => n.id === from), b = doc.nodes.find((n) => n.id === to);
  if (!a || !b) return "节点不存在";
  if (b.kind === "image" && a.kind === "audio") return "图片节点不接收音频输入";
  return null;
}

/** 视频节点按输入自动选生成方式 */
export function autoVideoMode(doc: CanvasDoc, id: string, m: ModelSpec): VideoMode | null {
  const n = doc.nodes.find((x) => x.id === id); if (!n || n.kind !== "video") return null;
  const ins = inputsOf(doc, id); const modes = m.modes || ["文生视频"];
  const imgs = ins.filter((x) => x.node.kind === "image").length, vids = ins.filter((x) => x.node.kind === "video").length, auds = ins.filter((x) => x.node.kind === "audio").length;
  const want: VideoMode = vids ? (imgs ? "参考视频生视频" : "视频延长") : auds && imgs ? "数字人" : imgs === 0 ? "文生视频" : imgs === 1 ? "首帧" : imgs === 2 ? "首尾帧" : "参考生视频";
  if (modes.includes(want)) return want;
  if (vids && modes.includes("视频编辑")) return "视频编辑";
  const alt: VideoMode = imgs ? "参考生视频" : "文生视频";
  return modes.includes(alt) ? alt : modes[0];
}

/* ---------- 引用 @节点·段落 ---------- */
export function sectionsOf(text: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}; const re = /(海报|镜头|方案)\s*(\d)\s*[：:]?\s*\n?([\s\S]*?)(?=\n\s*(?:海报|镜头|方案)\s*\d|$)/g; let m: RegExpExecArray | null;
  while ((m = re.exec(text || ""))) out[m[1] + m[2]] = m[3].trim();
  return out;
}
export function refsIn(prompt: string, ins: InputRef[]) {
  const found: Array<{ node: CanvasNode; key: string; text: string; order: number }> = [], missing: string[] = [];
  const re = /@([^\s@，。,]+?)·((?:海报|镜头|方案)\d)/g; let mm: RegExpExecArray | null;
  while ((mm = re.exec(prompt || ""))) {
    const hit = ins.find((x) => genOf(x.node).title === mm![1]); const secs = hit ? sectionsOf(textOf(hit.node)) : {};
    if (hit && secs[mm[2]]) found.push({ node: hit.node, key: mm[2], text: secs[mm[2]], order: hit.order }); else missing.push(mm[1] + "·" + mm[2]);
  }
  return { found, missing };
}

/* ---------- 小工具 ---------- */
let _seq = 0;
export const uid = (p = "n") => p + "_" + Date.now().toString(36) + (++_seq).toString(36) + Math.random().toString(36).slice(2, 5);
export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
export function ratioWH(r: string | undefined, long = 640): [number, number] {
  if (!r || /auto|自适应/i.test(r)) r = "3:4";
  const [a, b] = r.split(":").map(Number); if (!a || !b) return [long, long];
  return a >= b ? [long, Math.round((long * b) / a)] : [Math.round((long * a) / b), long];
}
export function bounds(nodes: CanvasNode[]) {
  if (!nodes.length) return null;
  const x = Math.min(...nodes.map((n) => n.x)), y = Math.min(...nodes.map((n) => n.y));
  const r = Math.max(...nodes.map((n) => n.x + n.w)), b = Math.max(...nodes.map((n) => n.y + n.h + 24));
  return { x, y, w: r - x, h: b - y };
}
export const nowStr = () => { const d = new Date(); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); };
