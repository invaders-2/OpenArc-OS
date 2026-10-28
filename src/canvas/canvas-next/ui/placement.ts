/**
 * 弹层定位（纯函数，单测覆盖）：按 anchor 矩形 + 弹层尺寸 + 视口做 flip（上下自动翻转）+ clamp（四周留 margin）。
 * 弹层比可用区域还大时：尺寸压到可用区域、位置贴到 margin，并让调用方给内部滚动（scrollX / scrollY）。
 * 坐标都相对视口左上角（fixed 定位），单位 px。
 */
export type PopRect = { x: number; y: number; width: number; height: number };
export type PopViewport = { width: number; height: number };
export type PopDir = "down" | "up" | "right";
export type PopAlign = "left" | "right";
export type PopPlacement = { x: number; y: number; maxWidth: number; maxHeight: number; origin: string; flipped: boolean; menu: boolean; scrollX: boolean; scrollY: boolean };

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));

export function placePopover(opts: {
  anchor: PopRect;
  popup: PopRect;
  viewport: PopViewport;
  dir?: PopDir;
  align?: PopAlign;
  margin?: number;
  gap?: number;
}): PopPlacement {
  const margin = Math.max(0, opts.margin ?? 8);
  const gap = Math.max(0, opts.gap ?? 8);
  const vw = Math.max(0, opts.viewport.width);
  const vh = Math.max(0, opts.viewport.height);
  const availW = Math.max(0, vw - margin * 2);
  const availH = Math.max(0, vh - margin * 2);
  const maxWidth = Math.min(Math.max(0, opts.popup.width), availW);
  const maxHeight = Math.min(Math.max(0, opts.popup.height), availH);
  const scrollX = opts.popup.width > availW + 0.5;
  const scrollY = opts.popup.height > availH + 0.5;
  const w = scrollX ? maxWidth : Math.max(0, opts.popup.width);
  const h = scrollY ? maxHeight : Math.max(0, opts.popup.height);
  const a = opts.anchor;
  const dir: PopDir = opts.dir ?? "down";
  const align: PopAlign = opts.align ?? "left";
  // 对齐：按指定方向对齐锚点；这一侧放不下而另一侧放得下时换成另一侧对齐（不被视口边缘挤歪）
  const leftAligned = a.x, rightAligned = a.x + a.width - w;
  const fitsL = leftAligned + w <= vw - margin, fitsR = rightAligned >= margin;
  const left = align === "right" ? (fitsR || !fitsL ? rightAligned : leftAligned) : (fitsL || !fitsR ? leftAligned : rightAligned);
  const below = a.y + a.height + gap;
  const above = a.y - gap - h;
  const spaceBelow = vh - margin - (a.y + a.height + gap);
  const spaceAbove = a.y - margin - gap;
  const spaceRight = vw - margin - (a.x + a.width + gap);
  let x = left;
  let y = below;
  let flipped = false;
  /** 上下两侧都放不下时：留在空间大的一侧，限高并内部滚动（不再被 clamp 推回去盖住锚点区域） */
  let fitH = 0;
  if (dir === "right") {
    if (spaceRight >= w) { x = a.x + a.width + gap; y = a.y; }
    else if (a.x - margin - gap >= w) { x = a.x - w - gap; y = a.y; flipped = true; }
    else { x = left; y = spaceBelow >= spaceAbove ? below : above; }
  } else if (dir === "up") {
    if (spaceAbove >= h) y = above;
    else if (spaceBelow >= h) { y = below; flipped = true; }
    else if (spaceAbove >= spaceBelow) { fitH = spaceAbove; y = a.y - gap - spaceAbove; }
    else { fitH = spaceBelow; y = below; flipped = true; }
  } else {
    if (spaceBelow >= h) y = below;
    else if (spaceAbove >= h) { y = above; flipped = true; }
    else if (spaceBelow >= spaceAbove) { fitH = spaceBelow; y = below; }
    else { fitH = spaceAbove; y = a.y - gap - spaceAbove; flipped = true; }
  }
  const finalX = maxWidth >= vw - margin * 2 ? margin : clamp(x, margin, Math.max(margin, vw - w - margin));
  const sideFit = !scrollY && fitH > 40 && fitH < h; // 弹层比整个视口还大时沿用原规则（铺满可用区）
  const outH = sideFit ? fitH : h;
  const finalY = sideFit ? y : maxHeight >= vh - margin * 2 ? margin : clamp(y, margin, Math.max(margin, vh - h - margin));
  const menu = dir === "down" && finalY > a.y;
  const origin = clamp(a.x + a.width / 2 - finalX, 0, w) + "px " + (a.y > finalY ? h : 0) + "px";
  return { x: finalX, y: finalY, maxWidth, maxHeight: sideFit ? Math.min(maxHeight, outH) : maxHeight, origin, flipped, menu, scrollX, scrollY: scrollY || sideFit };
}
