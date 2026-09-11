/**
 * D2-02 · z-order 单测（§15 / §7）。
 *
 * 冻结层级：Desktop → Window → System Overlay → Modal → Lock Screen。
 * 模块负责的是其中最底下两段之间的顺序："哪个窗口压在哪个窗口上面"。
 *
 * 核心性质：
 *   1. `state.order` 是 z-order 的**唯一真值**，`window.z` 只是它的缓存 ——
 *      两者恒等，任何命令之后都成立
 *   2. `aboveWindows` 必须是"顺序 + 可见性"的忠实投影，
 *      因为原生视图的遮挡判定直接吃它的输出（ADR §14）
 *   3. 置顶必须是**稳定**的：把 A 抬到最上不会颠倒其余窗口的相对顺序
 */
import test from "node:test";
import assert from "node:assert/strict";
import domain from "../electron/window-domain.cjs";
import manager from "../electron/window-manager.cjs";

const HOST = { width: 1440, height: 940 };

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const boot = (apps) =>
  manager.applyAll(domain.createState(), apps.map((appId) => ({ type: "window/open", appId })));

const zConsistent = (state) =>
  state.windows.every((w) => w.z === state.order.indexOf(w.id));

test("z 缓存恒等于 order 下标；新窗口落在最上层", () => {
  const state = boot(["home", "files", "settings"]);
  assert.deepEqual(state.order, ["home", "files", "settings"]);
  assert.ok(zConsistent(state));
  assert.equal(domain.zOf(state, "settings"), 2);
  assert.equal(domain.byId(state, "settings").z, 2);
  // 再来一个
  const more = manager.reduce(state, { type: "window/open", appId: "canvas" });
  assert.equal(domain.zOf(more, "canvas"), 3);
  assert.ok(zConsistent(more));
});

test("置顶是稳定的：抬 A 不颠倒其余窗口的相对顺序", () => {
  const state = boot(["a", "b", "c", "d"]);
  const raised = manager.reduce(state, { type: "window/focus", id: "b" });
  assert.deepEqual(raised.order, ["a", "c", "d", "b"]);
  // 其余三者的相对顺序必须原样保留
  const relative = (s) => s.order.filter((id) => id !== "b");
  assert.deepEqual(relative(raised), relative(state));
  assert.ok(zConsistent(raised));
  // 重复置顶是 no-op
  assert.equal(manager.reduce(raised, { type: "window/focus", id: "b" }), raised);
});

test("关闭窗口不改变其余窗口的相对顺序", () => {
  const state = boot(["a", "b", "c", "d"]);
  const closed = manager.reduce(state, { type: "window/close", id: "b" });
  assert.deepEqual(closed.order, ["a", "c", "d"]);
  assert.deepEqual(closed.order, state.order.filter((id) => id !== "b"));
  assert.ok(zConsistent(closed));
});

test("aboveWindows 是 order + 可见性的忠实投影", () => {
  const state = manager.applyAll(domain.createState(), [
    { type: "window/open", appId: "a", bounds: { x: 0, y: 44, w: 700, h: 500 } },
    { type: "window/open", appId: "b", bounds: { x: 50, y: 94, w: 700, h: 500 } },
    { type: "window/open", appId: "c", bounds: { x: 100, y: 144, w: 700, h: 500 } },
  ]);
  // 最下层窗口之上 = 其余全部（按自下而上的顺序）
  assert.deepEqual(domain.aboveWindows(state, "a").map((r) => r.id), ["b", "c"]);
  // 最上层窗口之上 = 空 → 无遮挡
  assert.deepEqual(domain.aboveWindows(state, "c"), []);
  // 把它压到最底
  const bottom = manager.reduce(state, { type: "window/focus", id: "a" });
  assert.deepEqual(domain.aboveWindows(bottom, "a"), []);
  assert.deepEqual(domain.aboveWindows(bottom, "b").map((r) => r.id), ["c", "a"]);
  // 矩形与 bounds 一致（原生视图的遮挡判定直接吃这些值）
  const rect = domain.aboveWindows(bottom, "c").find((r) => r.id === "a");
  assert.deepEqual(rect, { id: "a", x: 0, y: 44, width: 700, height: 500 });
});

test("最小化窗口不参与遮挡：它在 order 里但不在 aboveWindows 里", () => {
  const state = manager.applyAll(domain.createState(), [
    { type: "window/open", appId: "a" },
    { type: "window/open", appId: "b" },
    { type: "window/open", appId: "c" },
    { type: "window/minimize", id: "c" },
  ]);
  assert.equal(state.order.includes("c"), true, "最小化窗口仍在 order 中（它还活着）");
  assert.deepEqual(domain.aboveWindows(state, "a").map((r) => r.id), ["b"]);
  // 恢复后重新参与遮挡
  const restored = manager.reduce(state, { type: "window/restore", id: "c" });
  assert.deepEqual(domain.aboveWindows(restored, "a").map((r) => r.id), ["b", "c"]);
});

test("随机命令序列：不变量与 z 一致性在每一步都成立", () => {
  const rand = rng(0x2e0d1e);
  const APPS = ["a", "b", "c", "d", "e"];
  let state = domain.createState();
  for (let step = 0; step < 700; step += 1) {
    const live = state.windows.map((w) => w.id);
    const pick = () => [...live, "ghost"][Math.floor(rand() * (live.length + 1))];
    const roll = rand();
    let cmd;
    if (roll < 0.3 || !live.length) cmd = { type: "window/open", appId: APPS[Math.floor(rand() * APPS.length)] };
    else if (roll < 0.44) cmd = { type: "window/close", id: pick() };
    else if (roll < 0.62) cmd = { type: "window/focus", id: pick() };
    else if (roll < 0.72) cmd = { type: "window/minimize", id: pick() };
    else if (roll < 0.8) cmd = { type: "window/restore", id: pick() };
    else if (roll < 0.88) cmd = { type: "window/maximize", id: pick(), host: HOST };
    else if (roll < 0.94) cmd = { type: "window/unmaximize", id: pick() };
    else cmd = { type: "window/move", id: pick(), x: rand() * 1600, y: rand() * 1000, host: HOST };

    state = manager.reduce(state, cmd);
    assert.ok(zConsistent(state), `第 ${step} 步 ${cmd.type} 之后 z 与 order 漂移`);
    assert.deepEqual(domain.invariants(state), []);
    // order 是 windows 的一个排列
    assert.deepEqual([...state.order].sort(), state.windows.map((w) => w.id).sort());
  }
});

test("windows 数组顺序稳定：置顶只改 z，不重排数组（DOM 节点因此不移动）", () => {
  // 这一条锁的是"层级不得泄漏成数组顺序"。
  // windows 数组顺序 = 渲染层的 DOM 顺序；它一旦跟着 order 走，
  // 聚焦就会**移动** <section class="window"> 节点，而 pointerdown 里的聚焦
  // 恰好发生在 mousedown 与 mouseup 之间 —— 浏览器会因此放弃合成 click，
  // 表现是"点后台窗口的红绿灯按钮没反应，得点第二次"。
  const state = boot(["a", "b", "c", "d"]);
  const created = state.windows.map((w) => w.id);
  const raised = manager.reduce(state, { type: "window/focus", id: "a" });

  assert.deepEqual(raised.order, ["b", "c", "d", "a"], "order 必须跟着置顶变");
  assert.deepEqual(raised.windows.map((w) => w.id), created, "windows 数组顺序必须原样不动");
  assert.equal(domain.zOf(raised, "a"), 3, "z 必须跟着 order 走");
  assert.ok(zConsistent(raised));

  // z 没变时窗口对象必须保持同一引用（reindex 的"无变化 → 不换对象"性质）。
  // 最小化只改 state，不动 order，因此其余窗口的 z 不变。
  const min = manager.reduce(state, { type: "window/minimize", id: "b" });
  assert.equal(domain.byId(min, "a"), domain.byId(state, "a"));
  assert.equal(domain.byId(min, "b") === domain.byId(state, "b"), false, "被最小化的窗口必须换新对象");
  // 幂等命令整体返回原状态
  assert.equal(manager.reduce(state, { type: "window/focus", id: "d" }), state);

  // 一串聚焦 / 最小化 / 恢复之后依然稳定
  let s = raised;
  for (const id of ["c", "b", "d", "a", "c"]) s = manager.reduce(s, { type: "window/focus", id });
  s = manager.reduce(s, { type: "window/minimize", id: "b" });
  s = manager.reduce(s, { type: "window/restore", id: "b" });
  assert.deepEqual(s.windows.map((w) => w.id), created);
  assert.deepEqual(domain.invariants(s), []);
});

test("关闭再开之后，数组顺序仍按创建序（DOM 节点不跳位）", () => {
  const state = boot(["a", "b", "c"]);
  const closed = manager.reduce(state, { type: "window/close", id: "b" });
  assert.deepEqual(closed.windows.map((w) => w.id), ["a", "c"]);
  const reopened = manager.reduce(closed, { type: "window/open", appId: "b" });
  assert.deepEqual(reopened.windows.map((w) => w.id), ["a", "c", "b"]);
  assert.equal(domain.zOf(reopened, "b"), 2);
  assert.ok(zConsistent(reopened));
});

test("层级契约的边界：窗口顺序完全由 order 决定，不由创建时间或 id 决定", () => {
  // 反证：手工把 order 倒过来，层级必须跟着倒 —— 证明"创建时间"不是真值
  const state = boot(["a", "b", "c"]);
  const flipped = domain.reindex({ ...state, order: ["c", "b", "a"] });
  assert.equal(domain.zOf(flipped, "c"), 0);
  assert.equal(domain.zOf(flipped, "a"), 2);
  assert.deepEqual(domain.aboveWindows(flipped, "a"), []);
  assert.deepEqual(domain.aboveWindows(flipped, "c").map((r) => r.id), ["b", "a"]);
});
