export type Rect = { x: number; y: number; width: number; height: number };
export type Area = Rect;
export type WindowRect = { x: number; y: number; w: number; h: number };

export const MIN_W = 360;
export const MIN_H = 240;

export function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

export function rectOf(w: WindowRect | Rect): Rect {
  return { x: w.x, y: w.y, width: "w" in w ? w.w : w.width, height: "h" in w ? w.h : w.height };
}

export function intersects(a: Rect | null | undefined, b: Rect | null | undefined): boolean {
  if (!a || !b) return false;
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

export function inside(rect: Rect, area: Area): boolean {
  return rect.x >= area.x && rect.y >= area.y && rect.x + rect.width <= area.x + area.width && rect.y + rect.height <= area.y + area.height;
}

function distanceToArea(x: number, y: number, area: Area): number {
  const dx = Math.max(area.x - x, 0, x - (area.x + area.width));
  const dy = Math.max(area.y - y, 0, y - (area.y + area.height));
  return Math.hypot(dx, dy);
}

export function areaFor(win: WindowRect, areas: Area[]): Area | null {
  if (!areas || areas.length === 0) return null;
  const rect = rectOf(win);
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  return areas.find((area) => cx >= area.x && cx <= area.x + area.width && cy >= area.y && cy <= area.y + area.height)
    || areas.reduce((best, area) => distanceToArea(cx, cy, area) < distanceToArea(cx, cy, best) ? area : best);
}

export function clampWindow<T extends WindowRect>(win: T, areas: Area[], options?: { minWidth?: number; minHeight?: number }): T {
  const area = areaFor(win, areas);
  if (!area) return { ...win };
  const minW = Math.min(options?.minWidth ?? MIN_W, area.width);
  const minH = Math.min(options?.minHeight ?? MIN_H, area.height);
  const width = clamp(rectOf(win).width, minW, area.width);
  const height = clamp(rectOf(win).height, minH, area.height);
  const x = clamp(rectOf(win).x, area.x, Math.max(area.x, area.x + area.width - width));
  const y = clamp(rectOf(win).y, area.y, Math.max(area.y, area.y + area.height - height));
  return { ...win, x, y, w: width, h: height };
}

export function clampAll<T extends WindowRect>(wins: T[], areas: Area[], options?: { minWidth?: number; minHeight?: number }): T[] {
  return wins.map((win) => clampWindow(win, areas, options));
}

export function isVisible(win: WindowRect, areas: Area[]): boolean {
  if (!areas || areas.length === 0) return false;
  const rect = rectOf(clampWindow(win, areas));
  return areas.some((area) => inside(rect, area));
}

export function occluded(target: Rect | null | undefined, above: Rect[]): boolean {
  if (!target) return false;
  return (above || []).some((rect) => intersects(target, rect));
}
