/**
 * D5-02 · 图像参数（比例 + 分辨率 → size）与返回图 mime 归一化。
 *
 * 一份真源，两个消费方：
 *   · provider-adapter.cjs 的 mapImages：b64 分支不再硬编码 image/png，按上游声明的
 *     mime_type/mimeType 优先，缺失时按魔数嗅探，最后才回退。
 *   · canvas-service.cjs 的 modelCall：显式 size 优先；没有显式 size 时，把节点上的
 *     ratio / resolution / customSize / customRatio 映射成 OpenAI 兼容的 "WxH"。
 *
 * 映射表是数据（IMAGE_SIZE_TABLES），不是散落在 UI 里的常量；调用方可用 tables
 * 注入自己的表，也可以改这里默认值，测试直接读同一份表。
 *
 * 通用表内容与画布页唯一编辑器 public/novai-canvas/static/js/smart-canvas.js 的 SIZE_MAP 逐格一致
 * （APIMart 官方 gpt-image-2 15 比例 × 1k/2k/4k；上游 22feb298 起用它替换了旧 9 比例通用表）。
 * gpt-image-2 的离散枚举在上游 1e20abe51 里已从画布页静态表搬到服务端尺寸策略
 * （static/js/shared/size-policy.js 消费 model_protocols.json 的 gpt-image-2-family）；本文件用
 * GPT_IMAGE_2_SIZE_POLICY 镜像同一份策略，GPT_IMAGE_SIZE_TABLE 是它作用在通用表上的结果。
 * 这样 UI 送 size 与宿主兜底映射不会互相矛盾。
 */
"use strict";

const MAX_SIZE_LEN = 32;

/**
 * 图像请求参数白名单（与 chat 的 model-domain.PARAM_ALLOWLIST 分开，避免放宽 chat 面）。
 * size 是独立参数，不从这里走。给后续把图像参数接入 model-service 的人用。
 */
const IMAGE_PARAM_ALLOWLIST = Object.freeze([
  "quality", "aspect_ratio", "resolution", "response_format", "n", "seed",
  "style", "background", "output_format", "output_compression", "moderation", "user", "mime_type",
]);

/** 只保留白名单里的图像参数；空值一律剔除，不发送。 */
function pickImageParams(params) {
  const out = {};
  for (const [key, value] of Object.entries(params || {})) {
    if (!IMAGE_PARAM_ALLOWLIST.includes(key)) continue;
    if (value === undefined || value === null || value === "") continue;
    out[key] = value;
  }
  return out;
}

/** 比例别名 → 表里的键。同时接受 "16:9" 这种可读比例和表键本身。 */
const ASPECT_RATIO_ALIASES = Object.freeze({
  "1:1": "square", square: "square",
  "2:3": "portrait", portrait: "portrait",
  "3:2": "landscape", landscape: "landscape",
  "3:4": "portrait43", portrait43: "portrait43",
  "4:3": "landscape43", landscape43: "landscape43",
  "9:16": "story", story: "story",
  "16:9": "wide", wide: "wide",
  "21:9": "ultrawide", ultrawide: "ultrawide",
  "9:21": "ultratall", ultratall: "ultratall",
  "1:2": "portrait12", portrait12: "portrait12",
  "2:1": "landscape21", landscape21: "landscape21",
  "5:4": "landscape54", landscape54: "landscape54",
  "4:5": "portrait45", portrait45: "portrait45",
  "3:1": "landscape31", landscape31: "landscape31",
  "1:3": "portrait13", portrait13: "portrait13",
});

const RES_LONG_SIDE = Object.freeze({ "1k": 1536, "2k": 2048, "4k": 3840 });
const RES_PIXEL_LIMIT = Object.freeze({ "1k": 1572864, "2k": 4194304, "4k": 8294400 });

/**
 * APIMart 官方比例表：键 = 比例，值 = 分辨率档 → "WxH"（官方原样像素，不在这里做收口）。
 * 与 smart-canvas.js 的 SIZE_MAP 逐格一致；同档位官方给两组等价像素时取比例精确的第一组
 * （1:1@1k=1024x1024、3:1@1k=1536x512、1:3@1k=512x1536）。
 * 实际下发尺寸在 resolveImageSize 里按该档位像素上限等比收窄（与页面 apiImageSize 同口径）。
 */
const IMAGE_SIZE_TABLE = Object.freeze({
  square: Object.freeze({ "1k": "1024x1024", "2k": "2048x2048", "4k": "2880x2880" }),
  portrait: Object.freeze({ "1k": "1024x1536", "2k": "1360x2048", "4k": "2336x3520" }),
  portrait43: Object.freeze({ "1k": "768x1024", "2k": "1536x2048", "4k": "2480x3312" }),
  landscape43: Object.freeze({ "1k": "1024x768", "2k": "2048x1536", "4k": "3312x2480" }),
  landscape: Object.freeze({ "1k": "1536x1024", "2k": "2048x1360", "4k": "3520x2336" }),
  story: Object.freeze({ "1k": "864x1536", "2k": "1152x2048", "4k": "2160x3840" }),
  wide: Object.freeze({ "1k": "1536x864", "2k": "2048x1152", "4k": "3840x2160" }),
  ultrawide: Object.freeze({ "1k": "2016x864", "2k": "2688x1152", "4k": "3840x1648" }),
  ultratall: Object.freeze({ "1k": "864x2016", "2k": "1152x2688", "4k": "1648x3840" }),
  portrait12: Object.freeze({ "1k": "1024x2048", "2k": "1344x2688", "4k": "1920x3840" }),
  landscape21: Object.freeze({ "1k": "2048x1024", "2k": "2688x1344", "4k": "3840x1920" }),
  landscape54: Object.freeze({ "1k": "1280x1024", "2k": "2560x2048", "4k": "3216x2576" }),
  portrait45: Object.freeze({ "1k": "1024x1280", "2k": "2048x2560", "4k": "2576x3216" }),
  landscape31: Object.freeze({ "1k": "1536x512", "2k": "3072x1024", "4k": "3840x1280" }),
  portrait13: Object.freeze({ "1k": "512x1536", "2k": "1024x3072", "4k": "1280x3840" }),
});

/**
 * gpt-image-2 尺寸策略快照，与上游 server/protocols/model_protocols.json 的 gpt-image-2-family
 * 条目（match.model_patterns: ["gpt-image-2"]）逐字段一致。画布页 1e20abe51 起不再自带
 * GPT_IMAGE_2_SIZE_MAP，改由 static/js/shared/size-policy.js 消费这份策略；这里留一份镜像，
 * 让宿主兜底在拿不到页面策略时仍按同一份枚举收口。
 */
const GPT_IMAGE_2_SIZE_POLICY = Object.freeze({
  mode: "enum",
  autoSize: true,
  options: Object.freeze(["auto", "1024x1024", "1536x1024", "1024x1536", "2048x2048", "2048x1152", "3840x2160", "2160x3840"]),
  maxEdge: 3840,
  maxPixels: 8294400,
  minPixels: 655360,
  multipleOf: 16,
  prefer: "ratio",
  tiers: Object.freeze([
    Object.freeze({ id: "1k", maxPixels: 1572864 }),
    Object.freeze({ id: "2k", maxPixels: 4194304 }),
    Object.freeze({ id: "4k", maxPixels: 8294400 }),
  ]),
});

/**
 * gpt-image-2 官方 size 是离散枚举，长边 <=3840、总像素 <=8294400、宽高比 <=3:1，
 * 且没有正方形 4K；通用表会生成 4096x4096 / 2352x3520 等非法值被上游拒。
 * 本表 = 把 GPT_IMAGE_2_SIZE_POLICY 的约束作用到通用表每个格子上（与画布页 constrain 同结果）。
 */
const GPT_IMAGE_SIZE_TABLE = Object.freeze({
  square: Object.freeze({ "1k": "1024x1024", "2k": "2048x2048", "4k": "2048x2048" }),
  portrait: Object.freeze({ "1k": "1024x1536", "2k": "1024x1536", "4k": "2160x3840" }),
  portrait43: Object.freeze({ "1k": "1024x1536", "2k": "1024x1536", "4k": "2160x3840" }),
  landscape43: Object.freeze({ "1k": "1536x1024", "2k": "2048x1152", "4k": "3840x2160" }),
  landscape: Object.freeze({ "1k": "1536x1024", "2k": "2048x1152", "4k": "3840x2160" }),
  story: Object.freeze({ "1k": "1024x1536", "2k": "1024x1536", "4k": "2160x3840" }),
  wide: Object.freeze({ "1k": "1536x1024", "2k": "2048x1152", "4k": "3840x2160" }),
  ultrawide: Object.freeze({ "1k": "2048x1152", "2k": "2048x1152", "4k": "3840x2160" }),
  ultratall: Object.freeze({ "1k": "1024x1536", "2k": "1024x1536", "4k": "2160x3840" }),
  portrait12: Object.freeze({ "1k": "1024x1536", "2k": "1024x1536", "4k": "2160x3840" }),
  landscape21: Object.freeze({ "1k": "2048x1152", "2k": "2048x1152", "4k": "3840x2160" }),
  landscape54: Object.freeze({ "1k": "1536x1024", "2k": "3840x2160", "4k": "3840x2160" }),
  portrait45: Object.freeze({ "1k": "1024x1536", "2k": "2160x3840", "4k": "2160x3840" }),
  landscape31: Object.freeze({ "1k": "1536x1024", "2k": "2048x1152", "4k": "3840x2160" }),
  portrait13: Object.freeze({ "1k": "1024x1536", "2k": "1024x1536", "4k": "2160x3840" }),
});

const IMAGE_SIZE_TABLES = Object.freeze({ generic: IMAGE_SIZE_TABLE, gptImage: GPT_IMAGE_SIZE_TABLE });

/** 画布页 static/js/shared/size-policy.js 的 normalizeTable 期望的表格式。*/
const SIZE_POLICY_FORMAT = "novai-size-policy/v1";

/**
 * 非 gpt-image-2 模型的默认策略：free（不额外约束页面已算好的 size），但带上与 gpt-image-2-family
 * 同一份档位像素上限 —— 页面 resPixelLimitFor() 读的就是它（与页面 DEFAULT_POLICY 的兜底逐格一致）。
 * 不另写数值：tiers 直接引用上面那份唯一真源。
 */
const SIZE_POLICY_FREE = Object.freeze({
  mode: "free",
  hintOnly: false,
  maxEdge: 0,
  maxPixels: 0,
  minPixels: 0,
  multipleOf: 0,
  options: Object.freeze([]),
  prefer: "ratio",
  autoSize: false,
  defaultLevel: "",
  tiers: GPT_IMAGE_2_SIZE_POLICY.tiers,
});

/**
 * 把画布模型清单展开成页面 shared/size-policy.js 期望的 { format, default, models } 表。
 * entries: [{ key: 页面模型显示名(label，与 /api/config 的 image_models 一致), model: 用来判定家族的模型名 }]
 * 只有 gpt-image-2 家族挂 GPT_IMAGE_2_SIZE_POLICY；其余走 default。策略内容只来自本文件，不另写一份。
 *
 * sizes / gptSizes 是同一份表的只读投影：页面 normalizeTable 只读 format/default/models，未知字段
 * 原样忽略；宿主探针与测试用它们逐格核对 /api/ai/size-policy 下发值，不必再从页面静态表反推。
 */
function buildSizePolicyTable(entries) {
  const models = {};
  for (const entry of Array.isArray(entries) ? entries : []) {
    const key = String((entry && entry.key) || "").trim();
    if (!key) continue;
    if (isGptImageModel(entry && entry.model)) models[key] = GPT_IMAGE_2_SIZE_POLICY;
  }
  return { format: SIZE_POLICY_FORMAT, default: SIZE_POLICY_FREE, models, sizes: IMAGE_SIZE_TABLE, gptSizes: GPT_IMAGE_SIZE_TABLE };
}

/** WxH（也接受 W*H）；只在显式尺寸判定与自定义尺寸回读时用。 */
function parseSize(value) {
  const m = /^(\d{2,5})\s*[x*]\s*(\d{2,5})$/i.exec(String(value == null ? "" : value).trim());
  if (!m) return null;
  const width = Number(m[1]);
  const height = Number(m[2]);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** 显式尺寸（含上游自选 "auto"）——非空即原样采用，优先级最高。 */
function explicitSize(value) {
  const raw = String(value == null ? "" : value).trim();
  if (!raw) return null;
  return raw.slice(0, MAX_SIZE_LEN);
}

function parseRatio(value) {
  const raw = String(value == null ? "" : value).trim();
  if (!raw) return null;
  if (raw.includes(":")) {
    const parts = raw.split(":");
    const width = Number(parts[0]);
    const height = Number(parts[1]);
    if (width > 0 && height > 0) return width / height;
  }
  const n = Number(raw);
  return n > 0 ? n : null;
}

function gcdInt(a, b) {
  let x = Math.abs(Math.round(Number(a) || 0));
  let y = Math.abs(Math.round(Number(b) || 0));
  while (y) { const t = y; y = x % y; x = t; }
  return x || 1;
}

/**
 * 任意比例 → 最长边与像素上限约束下、16 对齐的 "WxH"。
 * 两条约束必须同时满足且保持比例：长边 <= longSide、宽*高 <= pixelLimit。
 * 画布页对 custom/source 比例只把像素上限压在一侧：1:1 @1k 会算成 1536x1248（非方形），
 * 4:3 @1k 的 1536x1072 与 3:2 @4k 的 3840x2336 也超过该档像素上限；这里按比例对称求解。
 */
function sizeFromRatio(widthRatio, resolutionKey) {
  const parsed = Number(widthRatio);
  if (!(parsed > 0)) return null;
  const resKey = RES_LONG_SIDE[resolutionKey] ? resolutionKey : "1k";
  const longSide = RES_LONG_SIDE[resKey] || 1024;
  const pixelLimit = RES_PIXEL_LIMIT[resKey] || (longSide * longSide);
  const maxLongSideFromPixels = Math.sqrt(pixelLimit * (parsed >= 1 ? parsed : 1 / parsed));
  if (parsed >= 1) {
    const width = Math.min(longSide, maxLongSideFromPixels);
    const height = width / parsed;
    return align16(width) + "x" + align16(height);
  }
  const height = Math.min(longSide, maxLongSideFromPixels);
  const width = height * parsed;
  return align16(width) + "x" + align16(height);
}

/** 16 对齐向下取整，且不小于 64（与画布页同一取整口径）。 */
function align16(value) {
  return Math.max(64, Math.floor(Number(value) / 16) * 16);
}

/**
 * 命名比例的派生收口：只按该档位像素上限等比缩放 + 16 对齐（与画布页 apiImageSize 的 oaTierFit
 * 同一口径，不做长边夹取）。官方表原样像素留在 IMAGE_SIZE_TABLE；这里产出实际下发的尺寸，
 * 否则 ultrawide@1k（2016x864）这类官方像素会超过 1k 档上限、与页面结果差一格。
 * gpt-image-2 的枚举收口已由 GPT_IMAGE_SIZE_TABLE 完成，不再走这里。
 */
function fitSizeToTier(size, resolutionKey) {
  const pair = parseSize(size);
  if (!pair) return size;
  const resKey = RES_PIXEL_LIMIT[resolutionKey] ? resolutionKey : "1k";
  const pixelLimit = RES_PIXEL_LIMIT[resKey] || 0;
  const area = pair.width * pair.height;
  if (!(pixelLimit > 0) || area <= pixelLimit) return pair.width + "x" + pair.height;
  const scale = Math.sqrt(pixelLimit / area);
  return align16(pair.width * scale) + "x" + align16(pair.height * scale);
}

function isGptImageModel(model) {
  const raw = String(model == null ? "" : model).trim().toLowerCase();
  const normalized = raw.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const compact = raw.replace(/[^a-z0-9]+/g, "");
  return normalized === "gpt-image-2" || normalized.startsWith("gpt-image-2-") || normalized.endsWith("-gpt-image-2")
    || normalized.includes("-gpt-image-2-") || compact === "gptimage2" || compact.startsWith("gptimage2") || compact.endsWith("gptimage2");
}

function tableFor(model, tables) {
  const source = tables && typeof tables === "object" ? tables : IMAGE_SIZE_TABLES;
  const table = isGptImageModel(model) ? source.gptImage : source.generic;
  return table && typeof table === "object" ? table : IMAGE_SIZE_TABLE;
}

/**
 * 解析最终 size。返回 null = 不发送 size 键（交给上游默认），不是伪造一个尺寸。
 * 优先级：显式 size > resolution=auto > resolution=custom 的 customSize > ratio+resolution 映射。
 */
function resolveImageSize({ size = null, ratio = null, resolution = null, customSize = null, customRatio = null, model = null, tables = null } = {}) {
  const explicit = explicitSize(size);
  if (explicit) return explicit;

  const resRaw = String(resolution == null ? "" : resolution).trim().toLowerCase();
  if (resRaw === "auto") return "auto";
  if (resRaw === "custom") {
    const custom = explicitSize(customSize);
    return custom && parseSize(custom) ? custom : null;
  }

  const ratioRaw = String(ratio == null ? "" : ratio).trim();
  // 比例与分辨率都没给 = 没有信号：返回 null（不发送 size 键），绝不凭空造一个尺寸。
  if (!ratioRaw && !resRaw) return null;

  const table = tableFor(model, tables);
  const square = table.square || IMAGE_SIZE_TABLE.square;
  const resKey = Object.prototype.hasOwnProperty.call(square, resRaw) ? resRaw : "1k";

  if (ratioRaw === "custom" || ratioRaw === "source") {
    const parsed = parseRatio(customRatio);
    if (parsed) return sizeFromRatio(parsed, resKey);
  }

  const alias = ASPECT_RATIO_ALIASES[ratioRaw];
  const key = alias && Object.prototype.hasOwnProperty.call(table, alias)
    ? alias
    : (Object.prototype.hasOwnProperty.call(table, ratioRaw) ? ratioRaw : "square");
  const row = table[key] || square;
  const cell = row[resKey] || square[resKey] || square["1k"] || null;
  return cell && !isGptImageModel(model) ? fitSizeToTier(cell, resKey) : cell;
}

/**
 * 对话式服务商（Lovart 这类只吃提示词、没有 size / aspect_ratio 字段的适配器）的尺寸要求。
 * 返回「画面比例 3:4，输出 1536×2048 像素」这种可以直接写进提示词的确定要求；
 * 比例与像素都拿不到时返回 null（不凭空造尺寸，与 resolveImageSize 同一纪律）。
 */
function sizeRequirement({ size = null, ratio = null } = {}) {
  const pair = parseSize(size);
  const parts = [];
  const ratioText = normalizeRatioText(ratio) || (pair ? ratioFromSize(pair) : null);
  if (ratioText) parts.push("画面比例 " + ratioText);
  if (pair) parts.push("输出 " + pair.width + "×" + pair.height + " 像素");
  return parts.length ? parts.join("，") : null;
}

/** 把尺寸要求拼到提示词末尾（提示词为空就整段作为提示词）；拿不到尺寸时原样返回。 */
function withSizeRequirement(prompt, options) {
  const base = String(prompt == null ? "" : prompt);
  const text = sizeRequirement(options);
  if (!text) return base;
  return base + (base.trim() ? "\n\n" : "") + "【画面要求】" + text + "，严格按此比例与尺寸出图。";
}

/** "3:4" 这类可读比例原样用；自适应 / custom / source / 数字等无法表达成比例的取值一律忽略。 */
function normalizeRatioText(value) {
  const m = /^\s*(\d{1,4}(?:\.\d+)?)\s*[:：]\s*(\d{1,4}(?:\.\d+)?)\s*$/.exec(String(value == null ? "" : value));
  if (!m) return null;
  const width = Number(m[1]);
  const height = Number(m[2]);
  return width > 0 && height > 0 ? m[1] + ":" + m[2] : null;
}

/** 像素 → 化简后的可读比例（1536x2048 → 3:4）；只在没有显式比例时用。 */
function ratioFromSize(pair) {
  if (!pair || !pair.width || !pair.height) return null;
  const divisor = gcdInt(pair.width, pair.height);
  const width = Math.round(pair.width / divisor);
  const height = Math.round(pair.height / divisor);
  return width > 0 && height > 0 && width <= 64 && height <= 64 ? width + ":" + height : null;
}

/** 从画布节点的可编辑字段解析（node.ratio / node.resolution / node.customSize / node.customRatio）。 */
function resolveImageSizeFromNode(node, { tables = null } = {}) {
  if (!node || typeof node !== "object") return null;
  return resolveImageSize({
    size: node.size,
    ratio: node.ratio,
    resolution: node.resolution,
    customSize: node.customSize,
    customRatio: node.customRatio,
    model: node.model,
    tables,
  });
}

/** 校验一份外来的比例表覆盖值；非法就抛，不静默吞掉配置错误。 */
function normalizeImageSizeTables(value) {
  if (value == null) return IMAGE_SIZE_TABLES;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("image size tables 必须是对象");
  const out = {};
  for (const [name, table] of Object.entries(value)) {
    if (!table || typeof table !== "object" || Array.isArray(table)) throw new Error("image size table 必须是对象：" + name);
    const rows = {};
    for (const [ratio, row] of Object.entries(table)) {
      if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("比例行必须是对象：" + name + "." + ratio);
      const cells = {};
      for (const [res, cell] of Object.entries(row)) {
        if (!parseSize(cell)) throw new Error("尺寸必须是 WxH：" + name + "." + ratio + "." + res);
        cells[res] = String(cell);
      }
      rows[ratio] = Object.freeze(cells);
    }
    out[name] = Object.freeze(rows);
  }
  return Object.freeze(out);
}

const IMAGE_MAGIC = Object.freeze([
  Object.freeze({ mime: "image/jpeg", bytes: Object.freeze([0xff, 0xd8, 0xff]) }),
  Object.freeze({ mime: "image/png", bytes: Object.freeze([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) }),
  Object.freeze({ mime: "image/gif", bytes: Object.freeze([0x47, 0x49, 0x46, 0x38]) }),
]);

/** 魔数嗅探；只回图片类型，嗅不出回 null。 */
function sniffImageMime(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  for (const sig of IMAGE_MAGIC) {
    if (buf.length >= sig.bytes.length && sig.bytes.every((b, i) => buf[i] === b)) return sig.mime;
  }
  if (buf.length >= 12 && buf.slice(0, 4).toString("ascii") === "RIFF" && buf.slice(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

function normalizeDeclaredMime(value) {
  const mime = String(value == null ? "" : value).trim().toLowerCase().split(";")[0].trim();
  return /^image\/[a-z0-9][a-z0-9.+-]*$/.test(mime) ? mime : null;
}

/**
 * data URL 的 mime：上游声明的 mime_type/mimeType 优先；
 * 缺失时只解码 base64 头部做魔数嗅探；都拿不到才回退（默认 image/png）。
 */
function resolveImageMime({ declared = null, base64 = null, fallback = "image/png" } = {}) {
  const field = normalizeDeclaredMime(declared);
  if (field) return field;
  if (typeof base64 === "string" && base64) {
    const head = Buffer.from(base64.slice(0, 24), "base64");
    const sniffed = sniffImageMime(head);
    if (sniffed) return sniffed;
  }
  return fallback;
}

module.exports = {
  MAX_SIZE_LEN,
  IMAGE_PARAM_ALLOWLIST,
  pickImageParams,
  ASPECT_RATIO_ALIASES,
  RES_LONG_SIDE,
  RES_PIXEL_LIMIT,
  IMAGE_SIZE_TABLE,
  GPT_IMAGE_2_SIZE_POLICY,
  GPT_IMAGE_SIZE_TABLE,
  IMAGE_SIZE_TABLES,
  SIZE_POLICY_FORMAT,
  SIZE_POLICY_FREE,
  buildSizePolicyTable,
  parseSize,
  parseRatio,
  sizeFromRatio,
  fitSizeToTier,
  isGptImageModel,
  resolveImageSize,
  resolveImageSizeFromNode,
  sizeRequirement,
  withSizeRequirement,
  normalizeRatioText,
  ratioFromSize,
  normalizeImageSizeTables,
  sniffImageMime,
  normalizeDeclaredMime,
  resolveImageMime,
  gcdInt,
};
