"use strict";
/**
 * D1-01 窗口几何：纯函数，无 Electron / DOM 依赖。
 *
 * 存在的理由：
 * - A05 要求"移除一个屏幕后重启，所有恢复窗口仍位于可见区域"。
 *   恢复是否可见必须是可计算、可断言的事实，不能靠肉眼。
 * - A12 要求网页原生视图不穿透 OpenArc 界面。
 *   原生视图永远绘制在 DOM 之上，唯一可靠的手段是判断遮挡并隐藏/收窄，
 *   因此"是否相交"必须可测。
 *
 * 所有坐标单位一致即可（主进程用 DIP，渲染进程用 CSS px），函数不做单位换算。
 */

const MIN_W = 360;
const MIN_H = 240;

function clamp(value, min, max) {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

function rectOf(w) {
  return { x: w.x, y: w.y, width: w.w ?? w.width, height: w.h ?? w.height };
}

/** 两个矩形是否有正面积的重叠。仅边或角相接不算重叠。 */
function intersects(a, b) {
  if (!a || !b) return false;
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

/** 矩形是否完整落在某个工作区内（用于断言"恢复后可见"）。 */
function inside(rect, area) {
  return (
    rect.x >= area.x &&
    rect.y >= area.y &&
    rect.x + rect.width <= area.x + area.width &&
    rect.y + rect.height <= area.y + area.height
  );
}

function distanceToArea(x, y, area) {
  const dx = Math.max(area.x - x, 0, x - (area.x + area.width));
  const dy = Math.max(area.y - y, 0, y - (area.y + area.height));
  return Math.hypot(dx, dy);
}

/** 选择窗口中心所在的工作区；都不在时退回最近的一个。 */
function areaFor(win, areas) {
  if (!areas || areas.length === 0) return null;
  const r = rectOf(win);
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  return (
    areas.find((a) => cx >= a.x && cx <= a.x + a.width && cy >= a.y && cy <= a.y + a.height) ||
    areas.reduce((best, a) =>
      distanceToArea(cx, cy, a) < distanceToArea(cx, cy, best) ? a : best,
    )
  );
}

/**
 * 把一个窗口收进可见工作区。
 * 不放大窗口：只缩小到工作区能容纳的尺寸，并保证至少有 MIN_W×MIN_H 可见。
 * 工作区比最小尺寸还小时，保证左上角对齐（退化情形，仍需可操作）。
 */
function clampWindow(win, areas, options) {
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

function clampAll(wins, areas, options) {
  return wins.map((w) => clampWindow(w, areas, options));
}

/**
 * A05 断言用：窗口经收拢后是否完整落在某个工作区内。
 * 先 clamp 再判断，因为"恢复后可见"指的是系统处理后的结果，不是原始存储值。
 */
function isVisible(win, areas) {
  if (!areas || areas.length === 0) return false;
  const r = rectOf(clampWindow(win, areas));
  return areas.some((a) => inside(r, a));
}

/**
 * A12：目标矩形是否被任一更高层矩形遮挡。
 * 原生 WebContentsView 永远绘制在 DOM 之上，因此只要存在重叠就必须隐藏，
 * 否则网页会穿透 OpenArc 的窗口、菜单和面板。
 */
function occluded(target, above) {
  if (!target) return false;
  return (above || []).some((r) => intersects(target, r));
}

module.exports = {
  MIN_W,
  MIN_H,
  clamp,
  rectOf,
  intersects,
  inside,
  areaFor,
  clampWindow,
  clampAll,
  isVisible,
  occluded,
};
