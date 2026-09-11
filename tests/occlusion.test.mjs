/**
 * 遮挡模型单测（`node --test`）。
 *
 * 覆盖两类断言：
 *   · 具体场景的期望结果（可读、能定位回归）
 *   · **面积守恒 + 互不重叠 + 不越界** 的不变量（用确定性随机场景批量验证，
 *     这类不变量才是"挖洞算法写对了"的真正证据）
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const occ = require("../electron/occlusion.cjs");

const VP = { x: 0, y: 0, width: 800, height: 600 };
const sumArea = (rects) => rects.reduce((s, r) => s + r.width * r.height, 0);
const inside = (r, o) =>
  r.x >= o.x && r.y >= o.y && r.x + r.width <= o.x + o.width && r.y + r.height <= o.y + o.height;
const overlaps = (a, b) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** 用细网格统计"视口内且不在任何遮挡内"的采样点数，作为空闲面积的真值参照。 */
function gridFreeArea(vp, occluders, step = 2) {
  let n = 0;
  for (let x = vp.x + step / 2; x < vp.x + vp.width; x += step) {
    for (let y = vp.y + step / 2; y < vp.y + vp.height; y += step) {
      const covered = occluders.some(
        (o) => x >= o.x && x < o.x + o.width && y >= o.y && y < o.y + o.height,
      );
      if (!covered) n += 1;
    }
  }
  return n * step * step;
}

test("freeRects：无遮挡时返回视口本身", () => {
  const f = occ.freeRects(VP, []);
  assert.equal(f.length, 1);
  assert.deepEqual(f[0], VP);
});

test("freeRects：完全覆盖时为空", () => {
  assert.deepEqual(occ.freeRects(VP, [{ x: -10, y: -10, width: 900, height: 700 }]), []);
});

test("freeRects：中心遮挡切成四条带，面积守恒", () => {
  const cut = { x: 300, y: 200, width: 200, height: 200 };
  const f = occ.freeRects(VP, [cut]);
  assert.equal(f.length, 4, "中心挖洞应得上下左右四块");
  assert.equal(sumArea(f), VP.width * VP.height - cut.width * cut.height);
  for (const r of f) assert.ok(inside(r, VP), "空闲矩形必须落在视口内");
});

test("freeRects：贴边遮挡不会切出零面积块", () => {
  const cut = { x: 0, y: 0, width: 200, height: 600 };
  const f = occ.freeRects(VP, [cut]);
  assert.ok(f.every((r) => r.width > 0 && r.height > 0));
  assert.equal(sumArea(f), 600 * (800 - 200));
});

test("freeRects：视口外的遮挡不影响结果", () => {
  const f = occ.freeRects(VP, [{ x: 2000, y: 2000, width: 100, height: 100 }]);
  assert.equal(sumArea(f), VP.width * VP.height);
});

test("提交的遮挡顺序不影响面积（可交换性）", () => {
  const a = { x: 100, y: 100, width: 200, height: 200 };
  const b = { x: 250, y: 250, width: 200, height: 200 };
  assert.equal(sumArea(occ.freeRects(VP, [a, b])), sumArea(occ.freeRects(VP, [b, a])));
});

test("classify：三态分类", () => {
  assert.equal(occ.classify(800 * 600, 800 * 600), "visible");
  assert.equal(occ.classify(0, 800 * 600), "fullyOccluded");
  assert.equal(occ.classify(1000, 800 * 600), "partiallyOccluded");
});

test("plan：最小化直接隐藏", () => {
  const p = occ.plan({ viewport: VP, minimized: true });
  assert.equal(p.mode, "hidden");
  assert.equal(p.bounds, null);
});

test("plan：系统级覆盖层整块让位，不做快照", () => {
  const p = occ.plan({ viewport: VP, occluders: [{ x: 0, y: 0, width: 100, height: 100 }], overlayOpen: true });
  assert.equal(p.mode, "hidden");
  assert.deepEqual(p.snapshotRects, [], "对话框/搜索/AI 面板打开时不应贴快照");
  assert.equal(p.classification, "partiallyOccluded");
});

test("plan：无遮挡时铺满视口", () => {
  const p = occ.plan({ viewport: VP });
  assert.equal(p.mode, "live");
  assert.deepEqual(p.bounds, VP);
  assert.deepEqual(p.snapshotRects, []);
});

test("plan：完全遮挡时改用快照占位", () => {
  const p = occ.plan({ viewport: VP, occluders: [{ x: -5, y: -5, width: 900, height: 700 }] });
  assert.equal(p.mode, "snapshot");
  assert.equal(p.classification, "fullyOccluded");
  assert.deepEqual(p.snapshotRects, [VP]);
});

test("plan：部分遮挡且最大空闲矩形够大 → clip+snapshot", () => {
  const cut = { x: 600, y: 0, width: 200, height: 600 }; // 挖掉右侧 1/4，最大空闲矩形 = 左侧 600x600（75%）
  const p = occ.plan({ viewport: VP, occluders: [cut] });
  assert.equal(p.mode, "clip+snapshot");
  assert.deepEqual(p.bounds, { x: 0, y: 0, width: 600, height: 600 });
  assert.ok(p.largestRatio >= occ.CLIP_MIN_RATIO);
  // 快照区必须正好补齐活动矩形之外的部分，二者并集为整个视口
  assert.equal(sumArea([p.bounds, ...p.snapshotRects]), VP.width * VP.height);
  assert.ok(p.snapshotRects.every((r) => !overlaps(r, p.bounds)));
});

test("plan：部分遮挡但最大空闲矩形过小 → 整块快照", () => {
  // 中心大洞，只留四条窄带，最大空闲矩形占视口比例低于阈值
  const cut = { x: 100, y: 100, width: 600, height: 400 };
  const p = occ.plan({ viewport: VP, occluders: [cut] });
  assert.equal(p.mode, "snapshot");
  assert.equal(p.bounds, null);
  assert.equal(p.classification, "partiallyOccluded");
});

test("plan：不可交互时即使空闲矩形很大也整块快照", () => {
  const cut = { x: 600, y: 0, width: 200, height: 600 };
  const p = occ.plan({ viewport: VP, occluders: [cut], interactive: false });
  assert.equal(p.mode, "snapshot");
});

test("plan：空视口隐藏", () => {
  assert.equal(occ.plan({ viewport: { x: 0, y: 0, width: 0, height: 0 } }).mode, "hidden");
});

test("plan：非法数值不产生 NaN 尺寸", () => {
  const p = occ.plan({ viewport: { x: NaN, y: 0, width: undefined, height: 100 } });
  assert.equal(p.mode, "hidden");
  const q = occ.plan({ viewport: VP, occluders: [{ x: NaN, y: NaN, width: NaN, height: NaN }] });
  assert.equal(q.mode, "live");
});

test("snapshotKey：视口或遮挡不变时稳定，变化时改变", () => {
  const base = { viewport: VP, occluders: [{ x: 1, y: 2, width: 3, height: 4 }], url: "https://a" };
  assert.equal(occ.snapshotKey(base), occ.snapshotKey({ ...base, occluders: [...base.occluders] }));
  assert.notEqual(occ.snapshotKey(base), occ.snapshotKey({ ...base, url: "https://b" }));
  assert.notEqual(
    occ.snapshotKey(base),
    occ.snapshotKey({ ...base, occluders: [{ x: 1, y: 2, width: 3, height: 5 }] }),
  );
});

test("不变量：随机场景下面积守恒、互不重叠、不越界", () => {
  // 确定性线性同余伪随机，保证可复现
  let seed = 20260910;
  const rnd = (n) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  for (let iter = 0; iter < 300; iter += 1) {
    const vp = { x: rnd(50), y: rnd(50), width: 40 + rnd(700), height: 40 + rnd(500) };
    const count = 1 + rnd(4);
    const cuts = Array.from({ length: count }, () => ({
      x: vp.x - 40 + rnd(vp.width + 80),
      y: vp.y - 40 + rnd(vp.height + 80),
      width: 10 + rnd(300),
      height: 10 + rnd(300),
    }));
    const free = occ.freeRects(vp, cuts);
    // 1) 全部落在视口内且非零面积
    for (const r of free) {
      assert.ok(r.width > 0 && r.height > 0, `iter${iter} 出现零面积块`);
      assert.ok(inside(r, vp), `iter${iter} 空闲矩形越界`);
    }
    // 2) 互不重叠
    for (let i = 0; i < free.length; i += 1)
      for (let j = i + 1; j < free.length; j += 1)
        assert.ok(!overlaps(free[i], free[j]), `iter${iter} 空闲矩形重叠`);
    // 3) 面积与细网格真值一致（允许半个网格的边界误差）
    const expected = gridFreeArea(vp, cuts, 4);
    const got = sumArea(free);
    assert.ok(
      Math.abs(got - expected) <= vp.width * 4 + vp.height * 4,
      `iter${iter} 面积不符 got=${got} expected≈${expected}`,
    );
  }
});
