/**
 * 画布编辑器 · 扩图框与笔刷圆圈的纯逻辑单测。
 *
 * 被测（产品真实代码）：src/canvas/canvas-next/ui/editors/outpaint-geometry.ts
 *   · 扩展框矩形计算（目标尺寸 / 原图偏移）
 *   · 比例吸附（只扩不够的那一根轴，居中分配，比例精确）
 *   · 尺寸换算（屏幕像素 ↔ 扩展比例）
 *   · 笔刷圆圈半径 = size / 2，以及"什么时候该显示圆圈"
 *
 * 只测纯函数：不碰 DOM、不碰 store、不联网。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  EXT_EPSILON,
  MAX_EXT,
  NO_EXT,
  PREVIEW_MAX_EXT,
  brushRadius,
  canConfirm,
  clampExt,
  clampPreview,
  dragExt,
  edgesOfHandle,
  fitRatio,
  hasExt,
  imageOffset,
  parseRatio,
  ratioOf,
  ringVisible,
  showsBrushRing,
  targetSize,
} from "../src/canvas/canvas-next/ui/editors/outpaint-geometry.ts";

const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

test("① 扩展框矩形：目标尺寸 = 原图 ×(1+两侧扩展)", () => {
  const base = { w: 1000, h: 800 };
  assert.deepEqual(targetSize(base, NO_EXT), { w: 1000, h: 800 }, "不扩就是原尺寸");
  assert.deepEqual(targetSize(base, { l: 0.5, t: 0, r: 0.5, b: 0 }), { w: 2000, h: 800 }, "左右各 50% → 宽翻倍");
  assert.deepEqual(targetSize(base, { l: 0, t: 0.25, r: 0, b: 0.25 }), { w: 1000, h: 1200 }, "上下各 25% → 高 ×1.5");
  assert.deepEqual(targetSize(base, { l: 0.1, t: 0.2, r: 0.3, b: 0.4 }), { w: 1400, h: 1280 }, "四边各自独立累加");
});

test("② 扩展框矩形：原图偏移 = 左侧 / 顶部扩展量（原图居中靠它摆）", () => {
  assert.deepEqual(imageOffset({ w: 1000, h: 800 }, NO_EXT), { x: 0, y: 0 });
  assert.deepEqual(imageOffset({ w: 1000, h: 800 }, { l: 0.25, t: 0.5, r: 0, b: 0 }), { x: 250, y: 400 });
  // 四边对称扩展时原图应正好居中
  const base = { w: 640, h: 480 }; const ext = { l: 0.3, t: 0.3, r: 0.3, b: 0.3 };
  const t = targetSize(base, ext); const o = imageOffset(base, ext);
  assert.equal(t.w - base.w - o.x, o.x, "左右留白相等");
  assert.equal(t.h - base.h - o.y, o.y, "上下留白相等");
});

test("③ 比例吸附：1:1 只扩「不够的那一根轴」，目标比例精确", () => {
  // 16:9 的图变 1:1 是「太宽」→ 往上下扩，左右不动
  const wide = { w: 1920, h: 1080 };
  const ew = fitRatio(wide, "1:1");
  assert.ok(ew, "能算出扩展");
  assert.equal(ew.l, 0, "横向不动");
  assert.equal(ew.r, 0);
  assert.ok(ew.t > 0 && ew.b > 0, "纵向向外扩");
  assert.ok(near(ew.t, ew.b, 1e-9), "上下对称");
  const tw = targetSize(wide, ew);
  assert.ok(near(tw.w / tw.h, 1, 0.002), "目标比例 1:1，实际 " + tw.w + "×" + tw.h);
  assert.equal(tw.w, 1920, "宽度保持原样（不放大不需要的那一轴）");

  // 竖图变 1:1 是「太窄」→ 往左右扩
  const tall = { w: 900, h: 1600 };
  const et = fitRatio(tall, "1:1");
  assert.equal(et.t, 0); assert.equal(et.b, 0);
  assert.ok(et.l > 0 && et.r > 0 && near(et.l, et.r, 1e-9), "左右对称扩展");
  assert.equal(targetSize(tall, et).h, 1600, "高度保持原样");
});

test("④ 比例吸附：9:16 往上下扩，16:9 往左右扩", () => {
  const base = { w: 1000, h: 1000 };
  const portrait = fitRatio(base, "9:16");
  assert.equal(portrait.l, 0); assert.equal(portrait.r, 0);
  assert.ok(portrait.t > 0 && portrait.b > 0);
  const tp = targetSize(base, portrait);
  assert.ok(near(tp.w / tp.h, 9 / 16, 0.002), "9:16 实际 " + tp.w + "×" + tp.h);

  const wide = fitRatio(base, "16:9");
  assert.equal(wide.t, 0); assert.equal(wide.b, 0);
  const tw = targetSize(base, wide);
  assert.ok(near(tw.w / tw.h, 16 / 9, 0.002), "16:9 实际 " + tw.w + "×" + tw.h);
});

test("⑤ 比例吸附：本来就同比例 → 不扩；非法比例 → null；全角冒号也认", () => {
  assert.deepEqual(fitRatio({ w: 1920, h: 1080 }, "16:9"), NO_EXT);
  assert.equal(fitRatio({ w: 100, h: 100 }, "自由"), null);
  assert.equal(fitRatio({ w: 100, h: 100 }, "1:0"), null);
  assert.equal(fitRatio({ w: 0, h: 100 }, "1:1"), null);
  assert.deepEqual(parseRatio("16：9"), { p: 16, q: 9 }, "全角冒号");
  assert.deepEqual(parseRatio(" 4:3 "), { p: 4, q: 3 }, "前后空格");
  assert.equal(parseRatio("16/9"), null);
});

test("⑥ 尺寸换算：屏幕位移 → 扩展比例（左右、上下分别按各自边长折算）", () => {
  const basePx = { w: 200, h: 100 };
  assert.equal(dragExt(NO_EXT, "e", 20, 0, basePx).r, 0.1, "右边界往右 20px / 宽 200 = 10%");
  assert.equal(dragExt(NO_EXT, "s", 0, 25, basePx).b, 0.25, "下边界往下 25px / 高 100 = 25%");
  assert.deepEqual(dragExt(NO_EXT, "nw", -10, -20, basePx), { l: 0.05, t: 0.2, r: 0, b: 0 }, "左上角同时改两边且方向相反");
  assert.equal(dragExt(NO_EXT, "w", -20, 0, basePx).l, 0.1, "左边界往左是正值");
});

test("⑦ 尺寸换算：反方向拖不会缩进原图（下界夹 0），上限夹 MAX_EXT", () => {
  assert.deepEqual(dragExt(NO_EXT, "e", -50, 0, { w: 100, h: 100 }), NO_EXT, "往左拖右边界不会让画布变小");
  const capped = dragExt(NO_EXT, "e", 10000, 0, { w: 100, h: 100 });
  assert.equal(capped.r, MAX_EXT, "单边最多扩到原图的 " + MAX_EXT + " 倍");
  const basePxZero = dragExt(NO_EXT, "e", 10, 0, { w: 0, h: 0 });
  assert.deepEqual(basePxZero, NO_EXT, "基准尺寸为 0 时不做除法、不产生 NaN");
});

test("⑧ 规整：小到看不见的扩展归零，且比例只留 3 位小数", () => {
  assert.deepEqual(clampExt({ l: EXT_EPSILON / 2, t: 0, r: 0, b: 0 }), NO_EXT);
  assert.deepEqual(clampExt({ l: 0.30004, t: 0, r: 0, b: 0 }), { l: 0.3, t: 0, r: 0, b: 0 });
  assert.deepEqual(clampExt({ l: -5, t: 9, r: 0, b: 0 }), { l: 0, t: MAX_EXT, r: 0, b: 0 });
  assert.deepEqual(clampExt({ l: NaN, t: 0.2, r: 0, b: 0 }), { l: 0, t: 0.2, r: 0, b: 0 });
});

test("⑧b 预览上限：拖得再远，每边也只到 PREVIEW_MAX_EXT（保证整框看得见）", () => {
  assert.equal(PREVIEW_MAX_EXT, 0.6);
  assert.deepEqual(clampPreview({ l: 5, t: 5, r: 5, b: 5 }), { l: 0.6, t: 0.6, r: 0.6, b: 0.6 });
  assert.deepEqual(clampPreview({ l: 0.2, t: 0, r: -3, b: 0.7 }), { l: 0.2, t: 0, r: 0, b: 0.6 });
  // 预览上限比硬上限更严：clampExt 允许到 2，clampPreview 只到 0.6
  assert.equal(clampExt({ l: 2, t: 0, r: 0, b: 0 }).l, 2);
  assert.equal(clampPreview({ l: 2, t: 0, r: 0, b: 0 }).l, 0.6);
});

test("⑨ 比例显示：常用比例约分正确，极端值退化成人话", () => {
  assert.equal(ratioOf({ w: 1920, h: 1080 }), "16:9");
  assert.equal(ratioOf({ w: 1000, h: 1000 }), "1:1");
  assert.equal(ratioOf({ w: 800, h: 600 }), "4:3");
  assert.equal(ratioOf({ w: 1777, h: 1000 }), "1.78:1", "约不开就退回小数比");
  assert.equal(ratioOf({ w: 0, h: 10 }), "—");
});

test("⑩ 句柄 → 边，以及「没扩就不能确认」", () => {
  assert.deepEqual(edgesOfHandle("n"), ["t"]);
  assert.deepEqual(edgesOfHandle("s"), ["b"]);
  assert.deepEqual(edgesOfHandle("e"), ["r"]);
  assert.deepEqual(edgesOfHandle("w"), ["l"]);
  assert.deepEqual(edgesOfHandle("ne"), ["t", "r"]);
  assert.deepEqual(edgesOfHandle("nw"), ["t", "l"]);
  assert.deepEqual(edgesOfHandle("se"), ["b", "r"]);
  assert.deepEqual(edgesOfHandle("sw"), ["b", "l"]);
  assert.equal(hasExt(NO_EXT), false);
  assert.equal(canConfirm(NO_EXT), false, "没扩出去时确认要禁用");
  assert.equal(canConfirm({ l: EXT_EPSILON / 2, t: 0, r: 0, b: 0 }), false, "几乎没扩也算没扩");
  assert.equal(canConfirm({ l: 0.02, t: 0, r: 0, b: 0 }), true);
});

test("⑪ 笔刷圆圈：半径 = size / 2（直径严格等于 size）", () => {
  for (const size of [6, 12, 28, 41, 80]) {
    assert.equal(brushRadius(size) * 2, size, "size=" + size + " 时直径必须等于 size");
  }
  assert.equal(brushRadius(28), 14);
  assert.equal(brushRadius(6), 3);
  assert.equal(brushRadius(80), 40);
  assert.equal(brushRadius(0), 0.5, "size 非法时按 1 兜底成半径 0.5");
  assert.equal(brushRadius(NaN), 0.5);
  assert.equal(brushRadius(-10), 0.5);
});

test("⑫ 笔刷圆圈：画笔 / 橡皮显示，矩形工具不显示；触屏和画布外都不显示", () => {
  assert.equal(showsBrushRing("brush"), true);
  assert.equal(showsBrushRing("eraser"), true);
  assert.equal(showsBrushRing("rect"), false, "矩形工具自己就是框，不再叠一个圆");
  assert.equal(ringVisible("brush", "mouse", true), true);
  assert.equal(ringVisible("eraser", "pen", true), true, "触控笔也算指针，可以显示");
  assert.equal(ringVisible("brush", "touch", true), false, "手指会挡住圆圈，不显示");
  assert.equal(ringVisible("brush", "mouse", false), false, "指针离开画布就隐藏");
  assert.equal(ringVisible("rect", "mouse", true), false);
});
