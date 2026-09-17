import arrowLight from "../../public/cursors/arrow-light.svg?raw";
import arrowDark from "../../public/cursors/arrow-dark.svg?raw";
import textLight from "../../public/cursors/text-light.svg?raw";
import textDark from "../../public/cursors/text-dark.svg?raw";
import resizeSeLight from "../../public/cursors/resize-se-light.svg?raw";
import resizeSeDark from "../../public/cursors/resize-se-dark.svg?raw";
import crosshairLight from "../../public/cursors/crosshair-light.svg?raw";
import crosshairDark from "../../public/cursors/crosshair-dark.svg?raw";
import grabLight from "../../public/cursors/grab-light.svg?raw";
import grabDark from "../../public/cursors/grab-dark.svg?raw";
import notAllowedLight from "../../public/cursors/not-allowed-light.svg?raw";
import notAllowedDark from "../../public/cursors/not-allowed-dark.svg?raw";
import copyLight from "../../public/cursors/copy-light.svg?raw";
import copyDark from "../../public/cursors/copy-dark.svg?raw";
import pointerLight from "../../public/cursors/pointer-light.svg?raw";
import pointerDark from "../../public/cursors/pointer-dark.svg?raw";

/** 自绘光标套装：public/cursors/*.svg 是唯一来源，Vite 用 ?raw 把源文件内联进 bundle
 *  （CSP connect-src 'none'，不能在运行时 fetch）。热点是 SVG 32 网格里的坐标。 */
const SOURCES = {
  arrow: { light: arrowLight, dark: arrowDark, hot: [2, 2], fallback: "default" },
  text: { light: textLight, dark: textDark, hot: [16, 15], fallback: "text" },
  "resize-se": { light: resizeSeLight, dark: resizeSeDark, hot: [16, 16], fallback: "nwse-resize" },
  crosshair: { light: crosshairLight, dark: crosshairDark, hot: [16, 16], fallback: "crosshair" },
  grab: { light: grabLight, dark: grabDark, hot: [16, 17], fallback: "grabbing" },
  "not-allowed": { light: notAllowedLight, dark: notAllowedDark, hot: [2, 2], fallback: "not-allowed" },
  copy: { light: copyLight, dark: copyDark, hot: [2, 2], fallback: "copy" },
  pointer: { light: pointerLight, dark: pointerDark, hot: [10, 5], fallback: "pointer" },
} as const;

export type CursorKind = keyof typeof SOURCES;
export const CURSOR_KINDS = Object.keys(SOURCES) as CursorKind[];
export const CURSOR_SIZE_MIN = 16;
export const CURSOR_SIZE_MAX = 40;
/** 默认 18px：实测系统箭头足印 25×38 设备像素（12.5×19 CSS 像素，含阴影），
 *  本套装 18px 足印 ≈34×34 设备像素（17×17 CSS），略小于系统箭头。 */
export const CURSOR_SIZE_DEFAULT = 18;

const VIEW = 32;

function scaled(svg: string, size: number) {
  return svg.replace(/width="32"\s+height="32"/, 'width="' + size + '" height="' + size + '"');
}

function valueOf(
  kind: CursorKind,
  state: { enabled: boolean; size: number; dark: boolean },
): string {
  const source = SOURCES[kind];
  if (!state.enabled) return source.fallback;
  const svg = scaled(state.dark ? source.dark : source.light, state.size);
  const k = state.size / VIEW;
  const hx = Math.round(source.hot[0] * k);
  const hy = Math.round(source.hot[1] * k);
  return 'url("data:image/svg+xml,' + encodeURIComponent(svg) + '") ' + hx + " " + hy + ", " + source.fallback;
}

/** 把整套光标写成根上的 CSS 变量。CSS 只负责"哪个元素用哪个变量"，
 *  并在 var() 里保留关键字兜底 —— 关掉自绘时这里写入的就是那些关键字。 */
export function applyCursors(state: { enabled: boolean; size: number; dark: boolean }) {
  const root = document.documentElement;
  for (const kind of CURSOR_KINDS) {
    root.style.setProperty("--cursor-" + kind, valueOf(kind, state));
  }
}
