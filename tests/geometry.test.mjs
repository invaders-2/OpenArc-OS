import { test } from "node:test";
import assert from "node:assert/strict";
import geometry from "../electron/geometry.cjs";

// A05：多窗口多屏，移除一个屏幕后重启，所有恢复窗口必须可见。
test("A05: windows restored after a display is removed must land in a visible work area", () => {
  const twoDisplays = [
    { x: 0, y: 0, width: 1440, height: 900 },
    { x: 1440, y: 0, width: 1920, height: 1080 },
  ];
  // 上次退出时窗口停在右侧屏幕靠右位置
  const persisted = [
    { id: "a", x: 2900, y: 120, w: 900, h: 600 },
    { id: "b", x: 1500, y: 300, w: 800, h: 500 },
    { id: "c", x: 120, y: 120, w: 700, h: 400 },
  ];
  // 右侧屏幕被拔掉
  const oneDisplay = [{ x: 0, y: 0, width: 1440, height: 900 }];

  // 前提用原始存储值判断：拔屏后确实有窗口整个落在可见区之外
  const rawOutside = persisted.filter(
    (w) => !geometry.inside(geometry.rectOf(w), oneDisplay[0]),
  );
  assert.equal(rawOutside.length, 2, "前提：拔屏后 a、b 两个窗口落在可见区之外");

  const restored = geometry.clampAll(persisted, oneDisplay);
  for (const w of restored)
    assert.ok(
      geometry.isVisible(w, oneDisplay),
      `窗口 ${w.id} 恢复后仍不可见：${JSON.stringify(w)}`,
    );
  // 仍在原屏的窗口不应被无谓搬动
  assert.deepEqual(
    { x: restored[2].x, y: restored[2].y },
    { x: 120, y: 120 },
    "本就可见的窗口不应被移动",
  );
});

test("A05: restore keeps at least a usable size instead of a zero-sized window", () => {
  const area = [{ x: 100, y: 50, width: 800, height: 600 }];
  const out = geometry.clampWindow({ x: 5000, y: 5000, w: 400, h: 300 }, area);
  assert.equal(out.w, 400);
  assert.equal(out.h, 300);
  assert.ok(geometry.inside(geometry.rectOf(out), area[0]));
  // 超出工作区的窗口被缩小但保留最小可操作尺寸
  const big = geometry.clampWindow({ x: 0, y: 0, w: 4000, h: 3000 }, area);
  assert.deepEqual({ w: big.w, h: big.h }, { w: 800, h: 600 });
});

test("A05: work area smaller than the minimum still yields a positioned window", () => {
  const tiny = [{ x: 0, y: 0, width: 200, height: 150 }];
  const out = geometry.clampWindow({ x: 9999, y: 9999, w: 600, h: 400 }, tiny);
  assert.ok(out.x >= 0 && out.y >= 0, "退化情形下仍给出可落位坐标");
  assert.ok(out.w > 0 && out.h > 0);
});

// A12：界面覆盖网页时，网页不得穿透。
test("A12: overlap is detected so the native view can be hidden", () => {
  const viewport = { x: 200, y: 150, width: 700, height: 500 };
  assert.equal(geometry.occluded(viewport, []), false);
  assert.equal(
    geometry.occluded(viewport, [{ x: 900, y: 150, width: 100, height: 100 }]),
    false,
    "完全在右侧的窗口不构成遮挡",
  );
  // 视口右下角是 (900,650)，只有完全越过角点的矩形才算不重叠
  assert.equal(
    geometry.occluded(viewport, [{ x: 900, y: 650, width: 200, height: 200 }]),
    false,
    "右下角外部不重叠",
  );
  assert.equal(
    geometry.occluded(viewport, [{ x: 800, y: 200, width: 300, height: 300 }]),
    true,
    "部分重叠必须判定为遮挡",
  );
  assert.equal(
    geometry.occluded(viewport, [{ x: 0, y: 0, width: 4000, height: 3000 }]),
    true,
    "全屏面板必须判定为遮挡",
  );
  // 仅边相接不算重叠，避免窗口贴边时误判
  assert.equal(
    geometry.occluded(viewport, [{ x: 900, y: 150, width: 100, height: 500 }]),
    false,
  );
});

test("A05: no display information means windows are left untouched", () => {
  const win = { x: 10, y: 20, w: 300, h: 200 };
  assert.deepEqual(geometry.clampWindow(win, []), win);
  assert.equal(geometry.isVisible(win, []), false);
});
