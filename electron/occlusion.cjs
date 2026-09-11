/**
 * OpenArc 遮挡模型（纯函数，无 Electron / DOM 依赖）。
 *
 * 背景（D2-02A 实测，见 docs/decisions/D2-02-window-system.md）：
 *   · WebContentsView 恒定绘制在 DOM 之上，DOM 的 z-index 对它无效
 *   · 单个矩形原生视图无法表达一般性的部分遮挡
 *   · 把"是否被遮挡"压成一个 boolean（有过遮挡就整块隐藏）会连同未遮挡区域一起丢掉
 *
 * 因此遮挡模型必须算出**空闲矩形集合**，再据此决定三种处置之一：
 *   live            —— 完全无遮挡，原生视图铺满视口
 *   clip+snapshot   —— 保留最大空闲矩形做实况，其余用页面快照补齐（视觉正确，快照区不可交互）
 *   snapshot        —— 空闲矩形太小不值得保留，整块换成快照
 *   hidden          —— 被系统级覆盖层（对话框 / 搜索 / AI 面板）整块覆盖，或窗口最小化
 *
 * 本模块只做几何与策略判定，不接触任何 Electron 对象，便于 `node --test` 直接覆盖。
 */

/** 最大空闲矩形占视口比例低于此值时，不再保留活动视图（改整块快照）。取值理由见 ADR。 */
const CLIP_MIN_RATIO = 0.35;
/** 视口几乎完全可见的阈值：空闲面积占比高于此值按"无遮挡"处理，避免无谓快照。 */
const FULL_RATIO = 0.999;

const clampNum = (n) => (Number.isFinite(n) ? n : 0);
const norm = (r) => ({
  x: clampNum(r.x),
  y: clampNum(r.y),
  width: Math.max(0, clampNum(r.width)),
  height: Math.max(0, clampNum(r.height)),
});
const empty = (r) => !r || r.width <= 0 || r.height <= 0;
const area = (r) => (empty(r) ? 0 : r.width * r.height);
const pos = (n) => (n < 0 ? 0 : n);

function intersects(a, b) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function intersection(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const width = Math.min(a.x + a.width, b.x + b.width) - x;
  const height = Math.min(a.y + a.height, b.y + b.height) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

/** 从一个矩形里挖掉一个相交矩形，返回最多 4 块互不重叠的剩余矩形。 */
function subtractOne(rect, cut) {
  const hit = intersection(rect, cut);
  if (!hit) return [rect];
  const out = [];
  const rx = rect.x + rect.width;
  const ry = rect.y + rect.height;
  const cx = cut.x + cut.width;
  const cy = cut.y + cut.height;
  // 上
  if (cut.y > rect.y) out.push({ x: rect.x, y: rect.y, width: rect.width, height: cut.y - rect.y });
  // 下
  if (cy < ry) out.push({ x: rect.x, y: cy, width: rect.width, height: ry - cy });
  // 左（纵向被 cut 的上下界夹住）
  const iy = pos(Math.max(rect.y, cut.y));
  const ih = pos(Math.min(ry, cy) - Math.max(rect.y, cut.y));
  if (ih > 0) {
    if (cut.x > rect.x) out.push({ x: rect.x, y: iy, width: cut.x - rect.x, height: ih });
    if (cx < rx) out.push({ x: cx, y: iy, width: rx - cx, height: ih });
  }
  return out.filter((r) => !empty(r));
}

/**
 * 视口减掉所有遮挡矩形后的空闲矩形集合（互不重叠，并集等于视口减去遮挡）。
 * 遮挡矩形会被裁到视口内；视口外的遮挡不参与。
 */
function freeRects(viewport, occluders) {
  const vp = norm(viewport);
  if (empty(vp)) return [];
  const cuts = (occluders || [])
    .map(norm)
    .filter((o) => !empty(o))
    .map((o) => intersection(vp, o))
    .filter(Boolean);
  let rects = [vp];
  for (const cut of cuts) {
    const next = [];
    for (const r of rects) next.push(...subtractOne(r, cut));
    rects = next;
    if (rects.length === 0) break;
  }
  return rects.filter((r) => !empty(r));
}

const totalArea = (rects) => (rects || []).reduce((s, r) => s + area(r), 0);

function largestRect(rects) {
  return (rects || []).reduce((best, r) => (area(r) > area(best) ? r : best), null);
}

/** §10 要求的三态分类：完全可见 / 部分遮挡 / 完全被遮挡。 */
function classify(freeA, viewportA) {
  const vp = clampNum(viewportA);
  if (vp <= 0) return "hidden";
  const ratio = clampNum(freeA) / vp;
  if (ratio >= FULL_RATIO) return "visible";
  if (ratio <= 0) return "fullyOccluded";
  return "partiallyOccluded";
}

/**
 * 计算一个浏览器视图的处置方案。
 *
 * @param viewport      视口矩形（窗口内容区坐标）
 * @param occluders     压在该视口之上的所有矩形（更高层窗口 / 系统覆盖层 / 窗口自身裁剪区）
 * @param minimized     宿主窗口是否最小化
 * @param overlayOpen   是否有系统级覆盖层（对话框 / 搜索 / AI 面板 / 右键菜单）
 * @param interactive   当前是否允许该视图可交互（非聚焦窗口时为 false）
 * @returns { mode, bounds, snapshotRects, classification, freeRects, freeArea, viewportArea, reason }
 */
function plan({ viewport, occluders = [], minimized = false, overlayOpen = false, interactive = true }) {
  const vp = norm(viewport);
  const vpA = area(vp);
  const base = { viewport: vp, viewportArea: vpA, freeRects: [], freeArea: 0 };

  if (minimized) {
    return { ...base, mode: "hidden", bounds: null, snapshotRects: [], classification: "hidden", reason: "窗口已最小化" };
  }
  if (empty(vp)) {
    return { ...base, mode: "hidden", bounds: null, snapshotRects: [], classification: "hidden", reason: "视口尺寸为空" };
  }

  const free = freeRects(vp, occluders);
  const freeA = totalArea(free);
  const classification = classify(freeA, vpA);
  const largest = largestRect(free);
  const largestA = area(largest);

  // 系统级覆盖层：整块让位，不做快照（覆盖层就是当前焦点，快照只会干扰）
  if (overlayOpen) {
    return {
      ...base,
      freeRects: free,
      freeArea: freeA,
      mode: "hidden",
      bounds: null,
      snapshotRects: [],
      classification,
      reason: "系统级覆盖层打开，整块隐藏",
    };
  }

  if (classification === "visible") {
    return { ...base, freeRects: free, freeArea: freeA, mode: "live", bounds: vp, snapshotRects: [], classification, reason: "无遮挡" };
  }

  if (classification === "fullyOccluded") {
    return {
      ...base,
      freeRects: free,
      freeArea: freeA,
      mode: "snapshot",
      bounds: null,
      snapshotRects: [vp],
      classification,
      reason: "完全被遮挡，改用快照占位",
    };
  }

  // 部分遮挡
  const ratio = largestA / vpA;
  const snapshotRects = freeRects(vp, [largest]).filter((r) => !empty(r));
  if (interactive && largest && ratio >= CLIP_MIN_RATIO) {
    return {
      ...base,
      freeRects: free,
      freeArea: freeA,
      mode: "clip+snapshot",
      bounds: largest,
      snapshotRects,
      largestRatio: ratio,
      classification,
      reason: `保留最大空闲矩形（占视口 ${(ratio * 100).toFixed(0)}%），其余由快照补齐`,
    };
  }
  return {
    ...base,
    freeRects: free,
    freeArea: freeA,
    mode: "snapshot",
    bounds: null,
    snapshotRects: [vp],
    largestRatio: ratio,
    classification,
    reason: interactive
      ? `最大空闲矩形占比 ${(ratio * 100).toFixed(0)}% 低于阈值 ${(CLIP_MIN_RATIO * 100).toFixed(0)}%，整块改用快照`
      : "视图当前不可交互，整块改用快照",
  };
}

/** 快照是否可复用：视口与遮挡都没变时不必重取。 */
function snapshotKey({ viewport, occluders, url }) {
  const vp = norm(viewport);
  const parts = (occluders || [])
    .map(norm)
    .filter((o) => !empty(o))
    .map((o) => `${o.x},${o.y},${o.width},${o.height}`)
    .sort();
  return [url || "", `${vp.x},${vp.y},${vp.width},${vp.height}`, ...parts].join("|");
}

module.exports = {
  CLIP_MIN_RATIO,
  FULL_RATIO,
  area,
  totalArea,
  empty,
  intersects,
  intersection,
  subtractOne,
  freeRects,
  largestRect,
  classify,
  plan,
  snapshotKey,
};
