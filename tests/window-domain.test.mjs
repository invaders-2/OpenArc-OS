/**
 * D2-02 · Window domain model 单测。
 *
 * 判据都不是"看起来对"，而是可证伪的性质：
 *   · 坏输入必须降级而不是抛异常（恢复路径抛异常 = 一次崩溃后永久打不开）
 *   · z 缓存必须与 order 下标恒等
 *   · focused 不得指向不存在或已最小化的窗口
 *   · appId → windowIds[] 必须能返回多个（§32 不允许"一个 App = 一个 Window"）
 */
import test from "node:test";
import assert from "node:assert/strict";
import domain from "../electron/window-domain.cjs";

const { WSTATE, MIN_WINDOW_W, MIN_WINDOW_H, AREA_TOP } = domain;

test("kindOf：只有登记的原生 App 才是 browser kind", () => {
  assert.equal(domain.kindOf("browser"), "browser");
  for (const app of ["home", "files", "settings", "canvas", "skills", "folder:x"])
    assert.equal(domain.kindOf(app), "app");
  assert.equal(domain.isNativeKind("browser"), true);
  assert.equal(domain.isNativeKind("app"), false);
});

test("normalizeBounds：非有限值退回 fallback，越界值被 clamp", () => {
  const fallback = { x: 10, y: 60, w: 700, h: 500 };
  // 完全缺失 → fallback（且 fallback 自身已满足最小尺寸，不被改动）
  assert.deepEqual(domain.normalizeBounds(null, fallback), fallback);
  assert.deepEqual(domain.normalizeBounds(undefined, fallback), fallback);

  // **非有限值**才退回 fallback；0 与负数都是有限值，走 clamp 而不是 fallback
  assert.deepEqual(domain.normalizeBounds({ x: NaN, y: Infinity, w: NaN, h: -Infinity }, fallback), {
    x: fallback.x,
    y: fallback.y,
    w: fallback.w,
    h: fallback.h,
  });
  assert.deepEqual(domain.normalizeBounds({ x: 1, y: 2, w: 0, h: -5 }, fallback), {
    x: 1,
    y: AREA_TOP,
    w: MIN_WINDOW_W,
    h: MIN_WINDOW_H,
  });

  // 低于最小尺寸 / 左下越界 → 抬到合法值
  const small = domain.normalizeBounds({ x: -80, y: 0, w: 1, h: 1 }, fallback);
  assert.equal(small.x, 0);
  assert.equal(small.y, AREA_TOP);
  assert.equal(small.w, MIN_WINDOW_W);
  assert.equal(small.h, MIN_WINDOW_H);
  // 小数被取整，避免亚像素值渗进持久化
  assert.deepEqual(domain.normalizeBounds({ x: 10.6, y: 60.4, w: 700.5, h: 500.5 }, fallback), {
    x: 11,
    y: 60,
    w: 701,
    h: 501,
  });
});

test("createWindow：restore 只在 MAXIMIZED 时非 null，避免跨次最大化串味", () => {
  const normal = domain.createWindow({ id: "home", appId: "home", bounds: { x: 1, y: 60, w: 600, h: 400 } });
  assert.equal(normal.state, WSTATE.NORMAL);
  assert.equal(normal.restore, null);
  assert.equal(normal.visible, true);

  const max = domain.createWindow({
    id: "files",
    appId: "files",
    state: "maximized",
    bounds: { x: 12, y: 52, w: 1000, h: 600 },
    restore: { x: 1, y: 60, w: 600, h: 400 },
  });
  assert.equal(max.state, WSTATE.MAXIMIZED);
  assert.deepEqual(max.restore, { x: 1, y: 60, w: 600, h: 400 });

  // 未知 state 字符串不能渗进域
  const bogus = domain.createWindow({ id: "x", appId: "x", state: "wat" });
  assert.equal(bogus.state, WSTATE.NORMAL);
});

test("windowsOfApp：同一 App 的多个窗口都必须被返回（§32）", () => {
  const state = domain.reindex({
    ...domain.createState(),
    windows: [
      domain.createWindow({ id: "browser", appId: "browser" }, 0),
      domain.createWindow({ id: "browser:2", appId: "browser" }, 1),
      domain.createWindow({ id: "home", appId: "home" }, 2),
    ],
    order: ["browser", "browser:2", "home"],
  });
  assert.deepEqual(domain.windowsOfApp(state, "browser"), ["browser", "browser:2"]);
  assert.deepEqual(domain.windowsOfApp(state, "home"), ["home"]);
  assert.deepEqual(domain.windowsOfApp(state, "nope"), []);
});

test("reindex：剔除幽灵 id、补上遗漏 id、写回 z 与 visible、修正 focused", () => {
  const raw = {
    ...domain.createState(),
    windows: [
      domain.createWindow({ id: "a", appId: "a" }, 0),
      domain.createWindow({ id: "b", appId: "b", state: "minimized" }, 1),
    ],
    order: ["ghost", "b", "a"], // ghost 不存在；a 的顺序被显式置后
    focused: "b", // 指向已最小化窗口 → 必须被清空
  };
  const state = domain.reindex(raw);
  assert.deepEqual(state.order, ["b", "a"]);
  assert.equal(domain.zOf(state, "b"), 0);
  assert.equal(domain.zOf(state, "a"), 1);
  assert.equal(domain.byId(state, "b").z, 0);
  assert.equal(domain.byId(state, "b").visible, false);
  assert.equal(state.focused, null);
  assert.deepEqual(domain.invariants(state), []);
});

test("aboveWindows：只返回目标之上、且未最小化的窗口", () => {
  const state = domain.reindex({
    ...domain.createState(),
    windows: [
      domain.createWindow({ id: "bottom", appId: "bottom", bounds: { x: 100, y: 100, w: 700, h: 500 } }, 0),
      domain.createWindow({ id: "mid", appId: "mid", bounds: { x: 200, y: 200, w: 700, h: 500 } }, 1),
      domain.createWindow({ id: "topMin", appId: "topMin", state: "minimized" }, 2),
      domain.createWindow({ id: "top", appId: "top", bounds: { x: 300, y: 300, w: 700, h: 500 } }, 3),
    ],
    order: ["bottom", "mid", "topMin", "top"],
  });
  const above = domain.aboveWindows(state, "bottom");
  assert.deepEqual(above.map((r) => r.id), ["mid", "top"]); // topMin 被排除
  assert.deepEqual(above[0], { id: "mid", x: 200, y: 200, width: 700, height: 500 });
  assert.deepEqual(domain.aboveWindows(state, "ghost"), []);
  // 最上层窗口之上没有任何东西 —— 这是"无遮挡"的最直接判据
  assert.deepEqual(domain.aboveWindows(state, "top"), []);
});

test("fromPersisted：坏数据一律降级，不抛异常", () => {
  for (const bad of [null, undefined, 42, "x", {}, { windows: "no" }, { windows: [null, 5, {}] }]) {
    const state = domain.fromPersisted(bad);
    assert.deepEqual(state.windows, [], `输入 ${JSON.stringify(bad)} 应恢复为空状态`);
    assert.deepEqual(domain.invariants(state), []);
  }
});

test("fromPersisted：丢弃重复 id，保留首个", () => {
  const state = domain.fromPersisted({
    windows: [
      { id: "home", appId: "home", bounds: { x: 10, y: 60, w: 700, h: 500 } },
      { id: "home", appId: "home", bounds: { x: 999, y: 999, w: 700, h: 500 } },
    ],
  });
  assert.equal(state.windows.length, 1);
  assert.equal(state.windows[0].bounds.x, 10);
});

test("fromPersisted：恢复后不预设焦点（不把上次的层级带到这次）", () => {
  const state = domain.fromPersisted({
    windows: [{ id: "a", appId: "a" }],
    focused: "a",
    order: ["a"],
  });
  assert.equal(state.focused, null);
});

test("isPersistable：只有带 windows 数组的对象才值得信任", () => {
  assert.equal(domain.isPersistable({ windows: [] }), true);
  assert.equal(domain.isPersistable({ windows: [{ id: "a" }] }), true);
  assert.equal(domain.isPersistable({}), false);
  assert.equal(domain.isPersistable(null), false);
  assert.equal(domain.isPersistable("x"), false);
});

test("invariants：能抓出被手工破坏的状态", () => {
  const base = domain.createState();
  const w = domain.createWindow({ id: "a", appId: "a" }, 0);
  // 手工制造四种不一致，逐条确认都能被抓到
  assert.ok(domain.invariants({ ...base, windows: [w], order: ["a", "a"] }).length > 0);
  assert.ok(domain.invariants({ ...base, windows: [w], order: ["ghost"] }).length > 0);
  assert.ok(domain.invariants({ ...base, windows: [{ ...w, z: 7 }], order: ["a"] }).length > 0);
  assert.ok(domain.invariants({ ...base, windows: [{ ...w, visible: false }], order: ["a"] }).length > 0);
  assert.ok(domain.invariants({ ...base, windows: [w], order: ["a"], focused: "ghost" }).length > 0);
  // 健康状态必须是空数组
  assert.deepEqual(domain.invariants({ ...base, windows: [w], order: ["a"] }), []);
});
