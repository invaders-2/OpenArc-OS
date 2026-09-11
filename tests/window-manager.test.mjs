/**
 * D2-02 · Window Manager 单测。
 *
 * 核心判据：
 *   1. `reduce` 是**唯一**变更入口 —— 9 条冻结命令必须各自有实现，且覆盖 §20 全部名称
 *   2. reduce 必须是纯的（不改入参），否则 useReducer 的 memo 会静默失效
 *   3. 未知命令必须原样返回（命令层要能承接未来的 AI 生成内容，不能因拼错 type 打死 UI）
 *   4. 每条命令之后域不变量都成立
 */
import test from "node:test";
import assert from "node:assert/strict";
import domain from "../electron/window-domain.cjs";
import manager from "../electron/window-manager.cjs";

const HOST = { width: 1440, height: 940 };
const { WSTATE } = domain;

const boot = (commands = []) => manager.applyAll(domain.createState(), commands);
const ids = (state) => [...state.order];
const snap = (state) => JSON.stringify({ order: state.order, focused: state.focused, z: state.windows.map((w) => w.z) });

test("命令契约：WINDOW_COMMANDS 恰好是 §20 的 9 条，且每条都有实现", () => {
  assert.deepEqual([...manager.WINDOW_COMMANDS].sort(), [
    "window/close",
    "window/focus",
    "window/maximize",
    "window/minimize",
    "window/move",
    "window/open",
    "window/resize",
    "window/restore",
    "window/unmaximize",
  ].sort());
  assert.equal(manager.WINDOW_COMMANDS.length, 9);
  assert.ok(Object.isFrozen(manager.WINDOW_COMMANDS));
  for (const type of manager.WINDOW_COMMANDS)
    assert.equal(typeof manager.REDUCERS[type], "function", `${type} 缺少实现`);
  // 系统级变更必须与命令层分开登记，避免"命令"概念被稀释
  for (const type of manager.SYSTEM_MUTATIONS) assert.equal(manager.WINDOW_COMMANDS.includes(type), false);
});

test("reduce：未知 / 畸形命令原样返回原状态（同一引用）", () => {
  const state = boot([{ type: "window/open", appId: "home" }]);
  for (const bad of [null, undefined, 42, "x", {}, { type: "window/nope" }, { type: 123 }])
    assert.equal(manager.reduce(state, bad), state);
});

test("reduce 是纯的：不改动入参 state 与其内部对象", () => {
  const state = boot([
    { type: "window/open", appId: "home" },
    { type: "window/open", appId: "files" },
  ]);
  const before = snap(state);
  const winsBefore = state.windows;
  const orderBefore = state.order;

  manager.applyAll(state, [
    { type: "window/focus", id: "home" },
    { type: "window/move", id: "files", x: 300, y: 200, host: HOST },
    { type: "window/resize", id: "files", w: 900, h: 700, host: HOST },
    { type: "window/maximize", id: "files", host: HOST },
    { type: "window/unmaximize", id: "files" },
    { type: "window/minimize", id: "files" },
    { type: "window/restore", id: "files" },
    { type: "window/close", id: "files" },
  ]);

  assert.equal(snap(state), before, "入参 state 被改动了");
  assert.equal(state.windows, winsBefore);
  assert.equal(state.order, orderBefore);
});

test("OPEN 是幂等的：同 id 重复 open 只聚焦，不新建", () => {
  const once = boot([{ type: "window/open", appId: "home" }]);
  const twice = manager.reduce(once, { type: "window/open", appId: "home" });
  assert.equal(twice.windows.length, 1);
  assert.equal(twice.focused, "home");
  // 但幂等路径仍要把它置顶
  const three = boot([
    { type: "window/open", appId: "home" },
    { type: "window/open", appId: "files" },
  ]);
  const refocus = manager.reduce(three, { type: "window/open", appId: "home" });
  assert.deepEqual(ids(refocus), ["files", "home"]);
  assert.equal(refocus.windows.length, 2);
});

test("OPEN：新窗口落在最上层，且同 App 可开多窗口（§32）", () => {
  const state = boot([
    { type: "window/open", appId: "browser", id: "browser" },
    { type: "window/open", appId: "browser", id: "browser:2" },
  ]);
  assert.deepEqual(ids(state), ["browser", "browser:2"]);
  assert.equal(domain.zOf(state, "browser:2"), 1);
  assert.deepEqual(domain.windowsOfApp(state, "browser"), ["browser", "browser:2"]);
  assert.deepEqual(domain.invariants(state), []);
});

test("CLOSE：关闭聚焦窗口后焦点落到最上层剩余可见窗口；关完变 null", () => {
  const three = boot([
    { type: "window/open", appId: "home" },
    { type: "window/open", appId: "files" },
    { type: "window/open", appId: "settings" },
  ]);
  const after = manager.reduce(three, { type: "window/close", id: "settings" });
  assert.deepEqual(ids(after), ["home", "files"]);
  assert.equal(after.focused, "files");
  // 关闭非聚焦窗口不改变焦点
  const other = manager.reduce(after, { type: "window/close", id: "home" });
  assert.equal(other.focused, "files");
  const empty = manager.reduce(other, { type: "window/close", id: "files" });
  assert.equal(empty.focused, null);
  assert.deepEqual(empty.windows, []);
  assert.deepEqual(domain.invariants(empty), []);
  // 关闭不存在的窗口是 no-op
  assert.equal(manager.reduce(three, { type: "window/close", id: "ghost" }), three);
});

test("MOVE：clamp 保底，最大化窗口不可移动，相同位置不产生新对象", () => {
  const state = boot([{ type: "window/open", appId: "home", bounds: { x: 100, y: 100, w: 800, h: 600 } }]);
  const moved = manager.reduce(state, { type: "window/move", id: "home", x: 5000, y: -50, host: HOST });
  const b = domain.byId(moved, "home").bounds;
  assert.equal(b.x, HOST.width - 800, "右边界应贴住 host");
  assert.equal(b.y, domain.AREA_TOP, "不允许移进顶栏");
  // 相同目标位置 → 同一引用（避免每帧拖动都生成新状态）
  assert.equal(manager.reduce(moved, { type: "window/move", id: "home", x: b.x, y: b.y, host: HOST }), moved);
  // 最大化后不可移动
  const max = manager.reduce(moved, { type: "window/maximize", id: "home", host: HOST });
  assert.equal(manager.reduce(max, { type: "window/move", id: "home", x: 10, y: 10, host: HOST }), max);
});

test("RESIZE：clamp 到 [minSize, host]，且不越出工作区；最大化时拒绝", () => {
  const state = boot([{ type: "window/open", appId: "home", bounds: { x: 100, y: 100, w: 800, h: 600 } }]);
  const tooSmall = manager.reduce(state, { type: "window/resize", id: "home", w: 10, h: 10, host: HOST });
  const s = domain.byId(tooSmall, "home");
  assert.equal(s.bounds.w, s.minSize.w);
  assert.equal(s.bounds.h, s.minSize.h);
  const tooBig = manager.reduce(state, { type: "window/resize", id: "home", w: 99999, h: 99999, host: HOST });
  const big = domain.byId(tooBig, "home").bounds;
  assert.equal(big.w, HOST.width - 100);
  assert.equal(big.h, HOST.height - 100 - 100);
  const max = manager.reduce(state, { type: "window/maximize", id: "home", host: HOST });
  assert.equal(manager.reduce(max, { type: "window/resize", id: "home", w: 500, h: 500, host: HOST }), max);
});

test("MINIMIZE/RESTORE：焦点交接正确，且最小化不丢 bounds", () => {
  const state = boot([
    { type: "window/open", appId: "home" },
    { type: "window/open", appId: "files" },
  ]);
  const min = manager.reduce(state, { type: "window/minimize", id: "files" });
  assert.equal(domain.byId(min, "files").state, WSTATE.MINIMIZED);
  assert.equal(domain.byId(min, "files").visible, false);
  assert.equal(min.focused, "home", "焦点应落到剩余可见窗口");
  assert.deepEqual(domain.byId(min, "files").bounds, domain.byId(state, "files").bounds);
  const rest = manager.reduce(min, { type: "window/restore", id: "files" });
  assert.equal(domain.byId(rest, "files").state, WSTATE.NORMAL);
  assert.equal(rest.focused, "files");
  assert.deepEqual(ids(rest), ["home", "files"]);
  // 重复 minimize 是 no-op
  assert.equal(manager.reduce(min, { type: "window/minimize", id: "files" }), min);
});

test("MAXIMIZE：保存 restore 快照，重复最大化不吃掉快照", () => {
  const state = boot([{ type: "window/open", appId: "home", bounds: { x: 100, y: 100, w: 800, h: 600 } }]);
  const max = manager.reduce(state, { type: "window/maximize", id: "home", host: HOST });
  const w = domain.byId(max, "home");
  assert.equal(w.state, WSTATE.MAXIMIZED);
  assert.deepEqual(w.restore, { x: 100, y: 100, w: 800, h: 600 });
  assert.equal(w.bounds.w, HOST.width - 24);
  // 幂等：第二次 maximize 不再覆盖快照（否则"还原"会被吃掉）
  const twice = manager.reduce(max, { type: "window/maximize", id: "home", host: HOST });
  assert.equal(twice, max);
  assert.deepEqual(domain.byId(twice, "home").restore, { x: 100, y: 100, w: 800, h: 600 });
  // 还原
  const un = manager.reduce(max, { type: "window/unmaximize", id: "home" });
  assert.deepEqual(domain.byId(un, "home").bounds, { x: 100, y: 100, w: 800, h: 600 });
  assert.equal(domain.byId(un, "home").state, WSTATE.NORMAL);
  assert.equal(domain.byId(un, "home").restore, null);
  assert.deepEqual(domain.invariants(un), []);
  // 非最大化时 unmaximize 是 no-op
  assert.equal(manager.reduce(state, { type: "window/unmaximize", id: "home" }), state);
});

test("FOCUS：置顶 + 取消最小化；已是最上层时不动 order", () => {
  const state = boot([
    { type: "window/open", appId: "home" },
    { type: "window/open", appId: "files" },
    { type: "window/minimize", id: "home" },
  ]);
  const f = manager.reduce(state, { type: "window/focus", id: "home" });
  assert.equal(domain.byId(f, "home").state, WSTATE.NORMAL);
  assert.equal(f.focused, "home");
  assert.deepEqual(ids(f), ["files", "home"]);
  // 已是最上层 → 同一引用（全局性质：无变化的命令不产生新状态）
  assert.equal(manager.reduce(f, { type: "window/focus", id: "home" }), f);
  // 不存在的 id → no-op
  assert.equal(manager.reduce(state, { type: "window/focus", id: "ghost" }), state);
});

test("system/reflow：复用 geometry.clampAll 把屏外窗口拉回可见工作区（A05）", () => {
  const state = boot([{ type: "window/open", appId: "home", bounds: { x: 5000, y: 500, w: 800, h: 600 } }]);
  const area = { x: 0, y: 33, width: 1728, height: 990 };
  const reflowed = manager.reduce(state, { type: "system/reflow", areas: [area], host: HOST });
  const b = domain.byId(reflowed, "home").bounds;
  assert.ok(b.x >= area.x && b.x + b.w <= area.x + area.width, `x=${b.x} w=${b.w} 未落入工作区`);
  assert.notEqual(b.x, 5000);
  // 空 areas → no-op（不猜工作区）
  assert.equal(manager.reduce(state, { type: "system/reflow", areas: [] }), state);
  // 最大化窗口按新 host 重算，而不是吃 clamp 结果
  const max = manager.reduce(state, { type: "window/maximize", id: "home", host: HOST });
  const r2 = manager.reduce(max, { type: "system/reflow", areas: [area], host: HOST });
  assert.equal(domain.byId(r2, "home").bounds.w, HOST.width - 24);
  assert.deepEqual(domain.invariants(r2), []);
});

test("system/native-state：只写 meta，不触碰 bounds / order / focused", () => {
  const state = boot([
    { type: "window/open", appId: "browser", id: "browser", meta: { url: "https://example.com" } },
    { type: "window/open", appId: "home" },
  ]);
  const next = manager.reduce(state, {
    type: "system/native-state",
    windowId: "browser",
    url: "https://example.org/",
    title: "Example",
    loading: false,
  });
  assert.equal(domain.byId(next, "browser").meta.url, "https://example.org/");
  assert.equal(domain.byId(next, "browser").meta.title, "Example");
  assert.deepEqual(next.order, state.order);
  assert.equal(next.focused, state.focused);
  assert.deepEqual(domain.byId(next, "browser").bounds, domain.byId(state, "browser").bounds);
  // 无变化 → 同一引用
  assert.equal(manager.reduce(next, { type: "system/native-state", windowId: "browser", url: "https://example.org/", title: "Example" }), next);
  // 不存在的窗口 → no-op
  assert.equal(manager.reduce(state, { type: "system/native-state", windowId: "ghost" }), state);
});

test("areaOf / maximizedBounds：工作区公式只有一处", () => {
  const area = manager.areaOf({ width: 1440, height: 940 });
  assert.deepEqual(area, { x: 0, y: 44, width: 1440, height: 940 - 44 - 114 });
  // 退化 host 不能产出负高度
  const tiny = manager.areaOf({ width: 10, height: 10 });
  assert.ok(tiny.width >= domain.MIN_WINDOW_W);
  assert.ok(tiny.height >= domain.MIN_WINDOW_H);
  assert.deepEqual(manager.maximizedBounds({ width: 1440, height: 940 }), { x: 12, y: 52, w: 1416, h: 782 });
});

test("nativeIntents：只有 browser kind 产出意图，且带上遮挡者与视口", () => {
  const state = boot([
    { type: "window/open", appId: "browser", id: "browser", bounds: { x: 60, y: 80, w: 700, h: 500 } },
    { type: "window/open", appId: "home", bounds: { x: 100, y: 120, w: 700, h: 500 } },
  ]);
  const intents = manager.nativeIntents(state, HOST);
  assert.equal(intents.length, 1);
  const [i] = intents;
  assert.equal(i.windowId, "browser");
  assert.equal(i.appId, "browser");
  assert.equal(i.present, true);
  assert.equal(i.focused, false); // home 是后开的，它才是聚焦者
  // 视口 = 窗口矩形挖掉 44px 标题栏（与 styles.css 的 .window-title 一致）
  assert.deepEqual(i.viewport, { x: 60, y: 124, width: 700, height: 456 });
  assert.deepEqual(i.occluders.map((o) => o.id), ["home"]);
  // 最小化后 present=false，但仍产出意图（控制器需要知道"该隐藏了"）
  const min = manager.reduce(state, { type: "window/minimize", id: "browser" });
  assert.equal(manager.nativeIntents(min, HOST)[0].present, false);
  // 非原生 App 永远不产出意图
  const onlyHome = boot([{ type: "window/open", appId: "home" }]);
  assert.deepEqual(manager.nativeIntents(onlyHome, HOST), []);
});
