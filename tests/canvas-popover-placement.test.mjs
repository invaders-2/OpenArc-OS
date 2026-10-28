/**
 * task-36：弹层定位纯函数（flip + clamp + 内部滚动）。
 * 覆盖：默认下方、下方放不下翻到上方、上方放不下翻到下方、右侧翻左、右对齐、
 * 四角 clamp、视口过小（弹层大于可用区）→ 尺寸压到可用区并标记滚动、点锚点、menu 标记。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { placePopover } from "../src/canvas/canvas-next/ui/placement.ts";

const viewport = { width: 1280, height: 800 };
const popup = { x: 0, y: 0, width: 320, height: 240 };
const inside = (p, v) => p.x >= 8 && p.y >= 8 && p.x + p.maxWidth <= v.width - 8 && p.y + p.maxHeight <= v.height - 8;

test("默认向下：锚点在左上时贴在锚点下方并对齐左边", () => {
  const p = placePopover({ anchor: { x: 100, y: 100, width: 40, height: 30 }, popup, viewport });
  assert.equal(p.x, 100);
  assert.equal(p.y, 138);
  assert.equal(p.flipped, false);
  assert.equal(p.maxWidth, 320);
  assert.equal(p.scrollX, false);
  assert.ok(inside(p, viewport));
});

test("下方放不下 → 翻到上方；上方也放不下 → 贴可用区并 clamp", () => {
  const flipped = placePopover({ anchor: { x: 100, y: 700, width: 40, height: 30 }, popup, viewport });
  assert.equal(flipped.flipped, true);
  assert.equal(flipped.y, 700 - 8 - 240);
  const tight = placePopover({ anchor: { x: 100, y: 300, width: 40, height: 30 }, popup, viewport: { width: 1280, height: 360 } });
  assert.ok(tight.y >= 8);
  assert.ok(tight.y + tight.maxHeight <= 360 - 8 + 0.001);
});

test("dir=up：上方优先，放不下翻到下方（flipped=true）", () => {
  const up = placePopover({ anchor: { x: 200, y: 500, width: 40, height: 30 }, popup, viewport, dir: "up", align: "left" });
  assert.equal(up.y, 500 - 8 - 240);
  const nearTop = placePopover({ anchor: { x: 200, y: 20, width: 40, height: 30 }, popup, viewport, dir: "up", align: "left" });
  assert.equal(nearTop.flipped, true);
  assert.equal(nearTop.y, 58);
  assert.ok(inside(nearTop, viewport));
});

test("dir=right：右边放不下翻到左边；两边都放不下时贴边 clamp", () => {
  const right = placePopover({ anchor: { x: 100, y: 100, width: 40, height: 30 }, popup, viewport, dir: "right", align: "left" });
  assert.equal(right.x, 148);
  const flip = placePopover({ anchor: { x: 1200, y: 100, width: 40, height: 30 }, popup, viewport, dir: "right", align: "left" });
  assert.equal(flip.flipped, true);
  assert.equal(flip.x, 1200 - 320 - 8);
});

test("右对齐：弹层右边缘贴锚点右边缘", () => {
  const p = placePopover({ anchor: { x: 500, y: 100, width: 60, height: 30 }, popup, viewport, dir: "down", align: "right" });
  assert.equal(p.x + p.maxWidth, 560);
});

test("四角锚点：弹层都不出视口（8px 安全边）", () => {
  for (const anchor of [
    { x: 8, y: 8, width: 30, height: 24 },
    { x: viewport.width - 38, y: 8, width: 30, height: 24 },
    { x: 8, y: viewport.height - 32, width: 30, height: 24 },
    { x: viewport.width - 38, y: viewport.height - 32, width: 30, height: 24 },
  ]) {
    for (const dir of ["down", "up", "right"]) {
      const p = placePopover({ anchor, popup, viewport, dir, align: "left" });
      assert.ok(inside(p, viewport), "dir=" + dir + " anchor=" + JSON.stringify(anchor) + " → " + JSON.stringify(p));
    }
  }
});

test("视口比弹层小：尺寸压到可用区、位置贴 margin、标记内部滚动", () => {
  const small = { width: 240, height: 180 };
  const p = placePopover({ anchor: { x: 40, y: 40, width: 40, height: 30 }, popup, viewport: small, dir: "down", align: "left" });
  assert.equal(p.maxWidth, 240 - 16);
  assert.equal(p.maxHeight, 180 - 16);
  assert.equal(p.scrollX, true);
  assert.equal(p.scrollY, true);
  assert.equal(p.x, 8);
  assert.equal(p.y, 8);
});

test("点锚点（坐标为点，宽高 0）与 menu 标记", () => {
  const p = placePopover({ anchor: { x: 300, y: 200, width: 0, height: 0 }, popup, viewport, dir: "down", align: "left" });
  assert.equal(p.y, 208);
  assert.equal(p.menu, true);
  const up = placePopover({ anchor: { x: 300, y: 500, width: 0, height: 0 }, popup, viewport, dir: "up", align: "left" });
  assert.equal(up.menu, false, "向上弹层不套 menu 动画");
});
