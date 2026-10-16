/**
 * 集中式「服务商 → 品牌 logo」映射（纯 TS：无 DOM、无网络、无 I/O，可离线单测）。
 *
 * 为什么单独一个模块：设置页的服务商列表与「协议设置」的协议列表必须用**同一套**判定 ——
 * 有品牌资源就上 logo（按主题与是否多色决定渲染方式），没有就回退界面既有的彩色首字母
 * （.mp2-logo + logoColor + mono），不拿 emoji / 文字 / 占位图凑数，也不把别的品牌硬套上来。
 *
 * 资源来源（public/ 根下）：
 *   · public/provider-logos/*.svg —— 12 个从 @lobehub/icons-static-svg 抓取的方形 mark
 *     + 1 个来自官方仓库 lovartai/lovart-skill（MIT）的 Lovart mark
 *     （品牌集合 / 文件 / 许可逐条见 public/provider-logos/manifest.json 与 SOURCES.md）；
 *   · public/novai-canvas/static/images/RunningHub-B.png（浅）/ RunningHub-W.png（深）——
 *     本仓既有 RunningHub 黑白两版字标（manifest 的 missing 里没有可用 SVG）。
 * 旧的火山引擎字标与 modelscope gif 仍留在 public/ 下，但不再是首选：新的方形 mark 让列表头像尺寸一致。
 *
 * 渲染约定（与 manifest.items[].multiColor 联动，见 providerLogoRender）：
 *   · multiColor:false 的 SVG 用 CSS mask（background: currentColor + mask-image），
 *     让图标跟随主题文字色；<img> 无法表达 currentColor，深色主题下会渲染成黑色而不可见；
 *   · multiColor:true 的 SVG 与 PNG（RunningHub）用 <img>，按主题选文件。
 *
 * URL 约定照 src-vue/apps.ts#iconUrl：相对 public 根的 "./<path>"（不写绝对路径）。
 */

export type ProviderLogoTheme = "light" | "dark";
export type ProviderLogoRender = "mask" | "img";

export interface ProviderLogoAsset {
  /** public/ 下的相对路径（不含前导 "./"）。 */
  readonly path: string;
  /** 可访问名称，用于 img[alt] 与探针取证。 */
  readonly label: string;
}

export interface ProviderLogo {
  readonly light: ProviderLogoAsset;
  readonly dark: ProviderLogoAsset;
  readonly multiColor: boolean;
}

/** 品牌资源表的一条；与 public/provider-logos/manifest.json 对齐，防漂移测试逐条核对。 */
export interface ProviderLogoBrand {
  readonly brand: string;
  readonly label: string;
  readonly multiColor: boolean;
  /** public/ 下浅色主题文件。 */
  readonly light: string;
  /** public/ 下深色主题文件；单色 SVG 与 light 相同，靠 mask 跟随主题文字色。 */
  readonly dark: string;
  /** manifest.items[].file；本仓自有资源（runninghub）为 null。 */
  readonly manifestFile: string | null;
  /** 该品牌的 id / 别名 token（小写原文，归一化由 candidateTokens 负责）。 */
  readonly aliases: readonly string[];
}

/**
 * 自动匹配的品牌资源表。前 12 条逐条对应 manifest.items（品牌 / file / multiColor 完全一致）；
 * runninghub 用本仓 PNG，不在 manifest.items 里。
 */
export const PROVIDER_BRAND_LOGOS: readonly ProviderLogoBrand[] = [
  { brand: "ollama", label: "Ollama", multiColor: false, light: "provider-logos/ollama.svg", dark: "provider-logos/ollama.svg", manifestFile: "provider-logos/ollama.svg", aliases: ["ollama"] },
  { brand: "openai", label: "OpenAI", multiColor: false, light: "provider-logos/openai.svg", dark: "provider-logos/openai.svg", manifestFile: "provider-logos/openai.svg", aliases: ["openai", "codex"] },
  { brand: "google-gemini", label: "Google Gemini", multiColor: false, light: "provider-logos/google-gemini.svg", dark: "provider-logos/google-gemini.svg", manifestFile: "provider-logos/google-gemini.svg", aliases: ["google-gemini", "gemini"] },
  { brand: "claude", label: "Claude", multiColor: false, light: "provider-logos/claude.svg", dark: "provider-logos/claude.svg", manifestFile: "provider-logos/claude.svg", aliases: ["claude", "anthropic", "apimart-claude"] },
  { brand: "xai", label: "xAI", multiColor: false, light: "provider-logos/xai.svg", dark: "provider-logos/xai.svg", manifestFile: "provider-logos/xai.svg", aliases: ["xai", "grok", "grok2api"] },
  { brand: "minimax", label: "MiniMax", multiColor: false, light: "provider-logos/minimax.svg", dark: "provider-logos/minimax.svg", manifestFile: "provider-logos/minimax.svg", aliases: ["minimax"] },
  { brand: "aliyun-bailian", label: "阿里云百炼", multiColor: false, light: "provider-logos/aliyun-bailian.svg", dark: "provider-logos/aliyun-bailian.svg", manifestFile: "provider-logos/aliyun-bailian.svg", aliases: ["aliyun-bailian", "bailian"] },
  { brand: "modelscope", label: "ModelScope", multiColor: false, light: "provider-logos/modelscope.svg", dark: "provider-logos/modelscope.svg", manifestFile: "provider-logos/modelscope.svg", aliases: ["modelscope"] },
  { brand: "volcengine", label: "火山引擎", multiColor: false, light: "provider-logos/volcengine.svg", dark: "provider-logos/volcengine.svg", manifestFile: "provider-logos/volcengine.svg", aliases: ["volcengine"] },
  { brand: "agnes", label: "Agnes AI", multiColor: false, light: "provider-logos/agnes.svg", dark: "provider-logos/agnes.svg", manifestFile: "provider-logos/agnes.svg", aliases: ["agnes"] },
  { brand: "jimeng", label: "即梦", multiColor: false, light: "provider-logos/jimeng.svg", dark: "provider-logos/jimeng.svg", manifestFile: "provider-logos/jimeng.svg", aliases: ["jimeng", "dreamina"] },
  { brand: "deepseek", label: "DeepSeek", multiColor: false, light: "provider-logos/deepseek.svg", dark: "provider-logos/deepseek.svg", manifestFile: "provider-logos/deepseek.svg", aliases: ["deepseek", "deepseek-http"] },
  { brand: "lovart", label: "Lovart", multiColor: false, light: "provider-logos/lovart.svg", dark: "provider-logos/lovart.svg", manifestFile: "provider-logos/lovart.svg", aliases: ["lovart"] },
  { brand: "runninghub", label: "RunningHub", multiColor: false, light: "novai-canvas/static/images/RunningHub-B.png", dark: "novai-canvas/static/images/RunningHub-W.png", manifestFile: null, aliases: ["runninghub"] },
];

const normalizeKey = (value: unknown): string => String(value ?? "").trim().toLowerCase();

/** 归一化时要剥掉的 providerId 变体后缀（-http / -relay / -speech / -canvas …）。 */
const VARIANT_SUFFIXES: readonly string[] = ["-http", "-relay", "-speech", "-canvas", "-video", "-model", "-media"];

/** 一个 id 的全部等价 token：原文、去 cli: 前缀、反复剥变体后缀。 */
function candidateTokens(raw: unknown): string[] {
  const key = normalizeKey(raw);
  if (!key) return [];
  const out = new Set<string>();
  const add = (value: string) => { if (value) out.add(value); };
  add(key);
  if (key.startsWith("cli:")) add(key.slice(4));
  let grew = true;
  while (grew) {
    grew = false;
    for (const token of [...out]) {
      for (const suffix of VARIANT_SUFFIXES) {
        if (token.endsWith(suffix) && token.length > suffix.length) {
          const next = token.slice(0, -suffix.length);
          if (!out.has(next)) { out.add(next); grew = true; }
        }
      }
    }
  }
  return [...out];
}

const BRAND_BY_ID: Readonly<Record<string, ProviderLogoBrand>> = Object.fromEntries(
  PROVIDER_BRAND_LOGOS.map((spec) => [spec.brand, spec]),
);

const BRAND_BY_TOKEN: Readonly<Record<string, string>> = (() => {
  const out: Record<string, string> = {};
  for (const spec of PROVIDER_BRAND_LOGOS) {
    for (const alias of spec.aliases) {
      const token = normalizeKey(alias);
      if (!out[token]) out[token] = spec.brand;
    }
  }
  return out;
})();

/**
 * 显示名别名 —— provider/list 的 safeProvider 只给 providerId/displayName/adapterType，
 * 用户自建服务商时 providerId 是随机 slug，只有 displayName 能反映品牌。
 * 仅登记**确实有 logo 资源**的品牌名，避免把别的品牌错配上图。
 */
export const PROVIDER_NAME_ALIASES: Readonly<Record<string, string>> = {
  火山引擎: "volcengine",
  火山方舟: "volcengine",
  魔搭: "modelscope",
  "model scope": "modelscope",
  "running hub": "runninghub",
  阿里云百炼: "aliyun-bailian",
  百炼: "aliyun-bailian",
  即梦: "jimeng",
  openai: "openai",
  gemini: "google-gemini",
  claude: "claude",
  anthropic: "claude",
  grok: "xai",
  xai: "xai",
  minimax: "minimax",
  ollama: "ollama",
  modelscope: "modelscope",
  volcengine: "volcengine",
  agnes: "agnes",
  jimeng: "jimeng",
  dreamina: "jimeng",
  deepseek: "deepseek",
  lovart: "lovart",
  runninghub: "runninghub",
};

function resolveBrand(raw: unknown, allowContains: boolean): string | null {
  const key = normalizeKey(raw);
  if (!key) return null;
  for (const token of candidateTokens(key)) {
    const brand = BRAND_BY_TOKEN[token];
    if (brand) return brand;
  }
  if (allowContains) {
    for (const [name, brand] of Object.entries(PROVIDER_NAME_ALIASES)) {
      if (key.includes(name)) return brand;
    }
  }
  return null;
}

/** 服务商身份候选（provider/list 的 safeProvider 只给 providerId/displayName/adapterType，
 * 不带 protocol；protocol/adapterType/displayName 都作为候选键参与匹配）。 */
export interface ProviderIdentity {
  providerId?: string | null;
  displayName?: string | null;
  protocol?: string | null;
  adapterType?: string | null;
}

export interface ResolvedProviderLogo extends ProviderLogoAsset {
  readonly key: string;
  readonly theme: ProviderLogoTheme;
  readonly url: string;
  readonly multiColor: boolean;
  readonly render: ProviderLogoRender;
}

/** 从候选身份里找出一个**有 logo 资源**的品牌；找不到返回 null（界面回退彩色首字母）。 */
export function resolveProviderLogoKey(
  identity: ProviderIdentity | string | null | undefined,
): string | null {
  if (typeof identity === "string") return resolveBrand(identity, false);
  if (!identity || typeof identity !== "object") return null;
  for (const value of [identity.providerId, identity.protocol, identity.adapterType]) {
    const brand = resolveBrand(value, false);
    if (brand) return brand;
  }
  return resolveBrand(identity.displayName, true);
}

export function hasProviderLogo(identity: ProviderIdentity | string | null | undefined): boolean {
  return resolveProviderLogoKey(identity) !== null;
}

/** 资源 URL：与 src-vue/apps.ts#iconUrl 同一约定（相对 public 根的 "./"）。 */
export function providerLogoUrl(path: string): string {
  return "./" + String(path ?? "").replace(/^\.?\//, "");
}

/**
 * 渲染方式：multiColor:false 的 SVG 走 CSS mask（跟随 currentColor）；
 * multiColor:true 的 SVG 与 PNG/GIF 走 <img>（按主题选文件）。
 */
export function providerLogoRender(path: string, multiColor: boolean): ProviderLogoRender {
  return !multiColor && /\.svg$/i.test(String(path || "")) ? "mask" : "img";
}

/** 解析出可直接放进模板的 logo；无 logo 时返回 null。 */
export function resolveProviderLogo(
  identity: ProviderIdentity | string | null | undefined,
  theme: ProviderLogoTheme | string | null | undefined,
): ResolvedProviderLogo | null {
  const key = resolveProviderLogoKey(identity);
  if (!key) return null;
  const spec = BRAND_BY_ID[key];
  if (!spec) return null;
  const resolvedTheme: ProviderLogoTheme = theme === "dark" ? "dark" : "light";
  const path = resolvedTheme === "dark" ? spec.dark : spec.light;
  return {
    key,
    theme: resolvedTheme,
    path,
    label: spec.label,
    url: providerLogoUrl(path),
    multiColor: spec.multiColor,
    render: providerLogoRender(path, spec.multiColor),
  };
}

/**
 * 键 = 本仓协议域真实存在的 provider/protocol id，逐条来自：
 *   · v2 15 条：electron/protocol-engine/builtins.cjs#BUILTIN_PROVIDER_PROTOCOLS_V2
 *   · legacy 21 条：electron/protocol-engine/legacy-protocols.cjs#PROVIDER_PROTOCOLS（含官方新增的 lovart）
 * 两者交集为 { openai-relay, agnes }，去重后共 34 个键。
 * 值为 null = 本仓没有该品牌的 logo 资源，界面保持彩色首字母（不编造图形）。
 * lovart 的品牌 SVG（public/provider-logos/lovart.svg）已由协议包 vendor 落地并补进
 * PROVIDER_BRAND_LOGOS，因此它现在是**有资源**的品牌。
 */
const PROVIDER_LOGO_KEYS: readonly string[] = [
  // v2 15 条
  "ollama-http", "openai-http", "aliyun-bailian-http", "openai-relay", "xai-http", "minimax-http",
  "gemini-http", "fhl-http", "agtoken-http", "zkki-http", "apimart-http", "modelscope-http",
  "volcengine-http", "volcengine-speech-http", "agnes",
  // legacy 21 条（去掉与 v2 重复的 openai-relay / agnes）
  "ollama", "cli:pippit", "cli:dreamina-canvas", "cli:jimeng", "cli:codex", "cli:gemini",
  "openai", "aliyun-bailian", "apimart", "agtoken", "zkki", "xai", "grok2api",
  "modelscope", "volcengine", "volcengine-speech", "minimax", "runninghub", "lovart",
];

export const PROVIDER_LOGOS: Readonly<Record<string, ProviderLogo | null>> = Object.freeze(
  Object.fromEntries(
    PROVIDER_LOGO_KEYS.map((key) => {
      const brand = resolveProviderLogoKey(key);
      const spec = brand ? BRAND_BY_ID[brand] : null;
      if (!spec) return [key, null];
      return [key, {
        light: { path: spec.light, label: spec.label },
        dark: { path: spec.dark, label: spec.label },
        multiColor: spec.multiColor,
      }];
    }),
  ),
);

export const PROVIDER_LOGO_THEMES: readonly ProviderLogoTheme[] = ["light", "dark"];

/** 无 logo 时的回退文案（与 ModelSettings.vue 既有 mono 同口径）。 */
export function providerInitials(name: string | null | undefined): string {
  const value = String(name ?? "").trim();
  if (!value) return "?";
  return /^[\u4e00-\u9fff]/.test(value) ? value.slice(0, 1) : value.slice(0, 2).toUpperCase();
}
