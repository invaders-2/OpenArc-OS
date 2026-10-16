/**
 * WCAG 对比度纯函数（零依赖）—— 供照片探针在 Node 侧判定 DS-A04。
 *
 * 为什么单独一层：'最终合成背景' 的取样发生在渲染页里（canvas 解码截图），
 * 但对比度公式本身必须能在 Node 里独立单测，且必须和页面里用的是同一份口径。
 * 这里不做任何 I/O，只吃颜色字符串与 RGB 三元组。
 */

/** 解析 css 颜色 rgb() / rgba() / #rrggbb / #rgb；解析不了返回 null（绝不猜颜色）。 */
export function parseColor(input) {
  if (typeof input !== "string") return null;
  const s = input.trim();
  if (!s || s === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  let m = s.match(/^rgba?\(([^)]+)\)$/i);
  if (m) {
    const parts = m[1].split(/[,\/\s]+/).filter((x) => x !== "");
    if (parts.length < 3) return null;
    const r = Number(parts[0]);
    const g = Number(parts[1]);
    const b = Number(parts[2]);
    const a = parts.length >= 4 ? Number(parts[3]) : 1;
    if (![r, g, b, a].every((n) => Number.isFinite(n))) return null;
    return { r, g, b, a };
  }
  m = s.match(/^#([0-9a-f]{3,8})$/i);
  if (m) {
    const h = m[1];
    if (h.length === 3 || h.length === 4) {
      const r = parseInt(h[0] + h[0], 16);
      const g = parseInt(h[1] + h[1], 16);
      const b = parseInt(h[2] + h[2], 16);
      const a = h.length === 4 ? parseInt(h[3] + h[3], 16) / 255 : 1;
      return { r, g, b, a };
    }
    if (h.length === 6 || h.length === 8) {
      const r = parseInt(h.slice(0, 2), 16);
      const g = parseInt(h.slice(2, 4), 16);
      const b = parseInt(h.slice(4, 6), 16);
      const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
      return { r, g, b, a };
    }
  }
  return null;
}

/** 前景（可带 alpha）叠加到不透明背景上，得到最终呈现色。 */
export function composite(fg, bg) {
  const a = Number.isFinite(fg.a) ? fg.a : 1;
  return {
    r: Math.round(fg.r * a + bg.r * (1 - a)),
    g: Math.round(fg.g * a + bg.g * (1 - a)),
    b: Math.round(fg.b * a + bg.b * (1 - a)),
    a: 1,
  };
}

function channel(c) {
  const v = Math.max(0, Math.min(255, c)) / 255;
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** 相对亮度（WCAG 2.x）。 */
export function relativeLuminance(rgb) {
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

/** 对比度比值；两侧同色返回 1。 */
export function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** DESIGN_SYSTEM §10：大字门槛 24 CSS px，或约 18.67 px 粗体（>=700）。 */
export function isLargeText(fontSizePx, fontWeight) {
  const size = Number(fontSizePx) || 0;
  const weight = Number(fontWeight) || 400;
  if (size >= 24) return true;
  if (size >= 18.66 && weight >= 700) return true;
  return false;
}

/** 文本对比门槛：大字 3:1，普通文本 4.5:1（DS §10）。 */
export function requiredTextRatio(fontSizePx, fontWeight) {
  return isLargeText(fontSizePx, fontWeight) ? 3 : 4.5;
}

/** 控件/状态标记门槛 3:1（DS §10）。 */
export const REQUIRED_CONTROL_RATIO = 3;

/**
 * 一次文本对比测量。
 * @param {{color: string, fontSize: number, fontWeight: number|string}} text
 * @param {{r:number,g:number,b:number}} bg 最终合成背景（不透明）
 */
export function measureTextContrast(text, bg) {
  const fg = parseColor(text.color);
  if (!fg || !bg) return { ok: false, reason: "颜色无法解析" };
  const effective = composite(fg, bg);
  const ratio = contrastRatio(effective, bg);
  const required = requiredTextRatio(text.fontSize, text.fontWeight);
  return {
    ok: true,
    color: text.color,
    effective: "rgb(" + effective.r + ", " + effective.g + ", " + effective.b + ")",
    background: "rgb(" + bg.r + ", " + bg.g + ", " + bg.b + ")",
    fontSize: Number(text.fontSize) || null,
    fontWeight: Number(text.fontWeight) || null,
    largeText: isLargeText(text.fontSize, text.fontWeight),
    required,
    ratio: Math.round(ratio * 100) / 100,
    pass: ratio + 1e-9 >= required,
  };
}

/** 把 rgb 三元组归一成人读字符串。 */
export function rgbText(rgb) {
  return "rgb(" + rgb.r + ", " + rgb.g + ", " + rgb.b + ")";
}
