/**
 * D2-02 · 焦点语义单测。
 *
 * §14 的硬要求：**唯一 focused window**，不允许"DOM 窗口显示 active
 * 但 WebContentsView 实际吃键盘"。
 *
 * 这里测的是域层的保证：任何命令序列之后，focused 要么是 null，
 * 要么恰好指向一个存在且未最小化的窗口。域不变量成立 + 渲染层只读域，
 * 才谈得上"只有一个焦点持有者"。
 *
 * 判据同 design-system-token-probe 的方法论：只用"从未失败过不算证据"的方式写 ——
 * 既测正向（应发生），也测反向（不应发生）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import domain from "../electron/window-domain.cjs";
import manager from "../electron/window-manager.cjs";

const { WSTATE } = domain;
const HOST = { width: 1440, height: 940 };
const APPS = ["home", "files", "settings", "browser", "canvas"];

/** 确定性 PRNG（mulberry32）—— 随机测试必须可复现。 */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const countFocused = (state) => state.windows.filter((w) => w.id === state.focused).length;

test("初始状态没有焦点（不假设「启动时谁在前」）", () => {
  const state = domain.createState();
  assert.equal(state.focused, null);
  assert.equal(domain.focusedWindow(state), null);
  assert.equal(domain.actionableId(state), null);
});

test("任何命令序列之后：focused 至多 1 个，且不得指向不存在或已最小化的窗口", () => {
  const rand = rng(0x5eed01);
  let state = domain.createState();
  const log = [];
  for (let step = 0; step < 900; step += 1) {
    const live = state.windows.map((w) => w.id);
    const all = [...live, "ghost"];
    const pick = () => all[Math.floor(rand() * all.length)];
    const roll = rand();
    let cmd;
    if (roll < 0.26 || !live.length) {
      const appId = APPS[Math.floor(rand() * APPS.length)];
      cmd = { type: "window/open", appId, id: `${appId}:${Math.floor(rand() * 3)}` };
    } else if (roll < 0.38) cmd = { type: "window/close", id: pick() };
    else if (roll < 0.52) cmd = { type: "window/focus", id: pick() };
    else if (roll < 0.62) cmd = { type: "window/minimize", id: pick() };
    else if (roll < 0.72) cmd = { type: "window/restore", id: pick() };
    else if (roll < 0.8) cmd = { type: "window/maximize", id: pick(), host: HOST };
    else if (roll < 0.86) cmd = { type: "window/unmaximize", id: pick() };
    else if (roll < 0.94)
      cmd = { type: "window/move", id: pick(), x: rand() * 2000 - 200, y: rand() * 1200 - 200, host: HOST };
    else cmd = { type: "window/resize", id: pick(), w: rand() * 2000, h: rand() * 1200, host: HOST };

    state = manager.reduce(state, cmd);
    log.push(cmd.type);

    const bad = domain.invariants(state);
    assert.deepEqual(bad, [], `第 ${step} 步 ${cmd.type}(${cmd.id || cmd.appId || "?"}) 之后不变量被破坏：${bad.join("；")}`);
    assert.ok(countFocused(state) <= 1, `第 ${step} 步后出现多个焦点持有者`);

    if (state.focused) {
      const f = domain.byId(state, state.focused);
      assert.ok(f, "focused 指向不存在的窗口");
      assert.notEqual(f.state, WSTATE.MINIMIZED, "focused 指向已最小化的窗口");
    }
  }
  assert.ok(log.length === 900);
});

test("最小化聚焦窗口 → 焦点交还最上层剩余可见窗口；全最小化 → null", () => {
  let state = manager.applyAll(domain.createState(), [
    { type: "window/open", appId: "home" },
    { type: "window/open", appId: "files" },
    { type: "window/open", appId: "settings" },
  ]);
  state = manager.reduce(state, { type: "window/minimize", id: "settings" });
  assert.equal(state.focused, "files", "应落到次上层的可见窗口");
  state = manager.reduce(state, { type: "window/minimize", id: "files" });
  assert.equal(state.focused, "home");
  state = manager.reduce(state, { type: "window/minimize", id: "home" });
  assert.equal(state.focused, null, "全部最小化时必须没有焦点持有者");
  assert.equal(domain.actionableId(state), null, "顶栏红绿灯应因无目标而禁用");
  assert.equal(domain.visibleWindows(state).length, 0);
});

test("焦点不会跳到已最小化的窗口上：只有显式 restore/focus 才能把它带回来", () => {
  let state = manager.applyAll(domain.createState(), [
    { type: "window/open", appId: "home" },
    { type: "window/open", appId: "files" },
    { type: "window/open", appId: "settings" },
  ]);
  // 先把 settings 最小化，再让 files 与 home 一起消失 —— 焦点必须是 null 而不是 settings
  state = manager.reduce(state, { type: "window/minimize", id: "settings" });
  state = manager.reduce(state, { type: "window/close", id: "files" });
  state = manager.reduce(state, { type: "window/close", id: "home" });
  assert.equal(state.focused, null, "不得退而求其次指向已最小化窗口");
  // 显式 restore 才把它带回来
  state = manager.reduce(state, { type: "window/restore", id: "settings" });
  assert.equal(state.focused, "settings");
  assert.equal(domain.byId(state, "settings").state, WSTATE.NORMAL);
});

test("FOCUS 与 RESTORE 对同一状态给出同一结果（共用同一条路径）", () => {
  const base = manager.applyAll(domain.createState(), [
    { type: "window/open", appId: "home" },
    { type: "window/open", appId: "files" },
    { type: "window/minimize", id: "home" },
  ]);
  const viaFocus = manager.reduce(base, { type: "window/focus", id: "home" });
  const viaRestore = manager.reduce(base, { type: "window/restore", id: "home" });
  assert.deepEqual(
    { order: viaFocus.order, focused: viaFocus.focused, state: domain.byId(viaFocus, "home").state },
    { order: viaRestore.order, focused: viaRestore.focused, state: domain.byId(viaRestore, "home").state },
  );
});

test("无变化的焦点命令返回同一引用（避免无意义的重渲染）", () => {
  const state = manager.applyAll(domain.createState(), [
    { type: "window/open", appId: "home" },
    { type: "window/open", appId: "files" },
  ]);
  // files 已是最上层且已聚焦
  assert.equal(state.focused, "files");
  assert.equal(manager.reduce(state, { type: "window/focus", id: "files" }), state);
  assert.equal(manager.reduce(state, { type: "window/restore", id: "files" }), state);
  // 但把它最小化后 restore 必须真的改变状态
  const min = manager.reduce(state, { type: "window/minimize", id: "files" });
  assert.notEqual(manager.reduce(min, { type: "window/restore", id: "files" }), min);
});
