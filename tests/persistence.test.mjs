/**
 * D2-02 · 窗口持久化单测（§22 / §23 / A05）。
 *
 * 冻结的持久化口径：
 *   · 存储仍是 `localStorage["oa-wins"]` 这一个键，但**只能经 Window Manager 读写**
 *   · **不保存**临时状态：focused、z-order、opening / closing / modal 等瞬时态
 *     都不进域模型，因此也不可能被写出去
 *   · 恢复必须**降级而不抛异常**：一次崩溃不能换来"永久打不开"
 *   · 恢复后必须重新收拢到当前可见工作区（A05）
 */
import test from "node:test";
import assert from "node:assert/strict";
import domain from "../electron/window-domain.cjs";
import manager from "../electron/window-manager.cjs";

const HOST = { width: 1440, height: 940 };
const AREA = { x: 0, y: 33, width: 1728, height: 990 };

const boot = (apps) =>
  manager.applyAll(domain.createState(), apps.map((appId) => ({ type: "window/open", appId })));

test("序列化只写跨会话成立的字段；focused / order / z 一律不写", () => {
  let state = boot(["home", "files"]);
  state = manager.reduce(state, { type: "window/focus", id: "home" });
  const raw = JSON.parse(manager.serialize(state));

  assert.equal(raw.v, 2, "必须有版本号，否则无法演进");
  assert.deepEqual(Object.keys(raw).sort(), ["v", "windows"]);
  assert.equal("focused" in raw, false, "焦点是会话内状态，不该被持久化");
  assert.equal("order" in raw, false, "z-order 是会话内状态，不该被持久化");
  for (const w of raw.windows) {
    assert.equal("z" in w, false, `window ${w.id} 不应写 z`);
    assert.equal("visible" in w, false, `window ${w.id} 不应写 visible（可从 state 推导）`);
    assert.deepEqual(
      Object.keys(w).sort(),
      ["appId", "bounds", "displayId", "id", "kind", "meta", "minSize", "restore", "state"],
    );
  }
});

test("round-trip：bounds / state / restore / meta / appId / kind 全部无损", () => {
  let state = manager.applyAll(domain.createState(), [
    { type: "window/open", appId: "home", bounds: { x: 90, y: 94, w: 830, h: 570 } },
    { type: "window/open", appId: "browser", id: "browser", meta: { url: "https://example.com", title: "例子" } },
    { type: "window/open", appId: "files", bounds: { x: 200, y: 200, w: 700, h: 500 } },
    { type: "window/maximize", id: "files", host: HOST },
    { type: "window/minimize", id: "home" },
  ]);
  const back = manager.deserialize(JSON.parse(manager.serialize(state)), [AREA]);

  assert.deepEqual(back.windows.map((w) => w.id).sort(), ["browser", "files", "home"]);
  const h = domain.byId(back, "home");
  const f = domain.byId(back, "files");
  const b = domain.byId(back, "browser");
  assert.equal(h.state, domain.WSTATE.MINIMIZED);
  assert.equal(h.visible, false);
  assert.deepEqual(h.bounds, { x: 90, y: 94, w: 830, h: 570 });
  assert.equal(f.state, domain.WSTATE.MAXIMIZED);
  assert.deepEqual(f.restore, { x: 200, y: 200, w: 700, h: 500 }, "restore 快照必须无损");
  assert.equal(b.kind, "browser");
  assert.equal(b.meta.url, "https://example.com");
  assert.deepEqual(domain.invariants(back), []);
});

test("恢复后不假设焦点：不把上一次的层级带到这一次", () => {
  const state = manager.reduce(boot(["home", "files"]), { type: "window/focus", id: "home" });
  const back = manager.deserialize(JSON.parse(manager.serialize(state)), [AREA]);
  assert.equal(back.focused, null, "上次退出时谁在最上层不该决定下次启动的层级");
  // order 仍在（它是一个合法的排列），但焦点为空
  assert.deepEqual([...back.order].sort(), ["files", "home"]);
});

test("A05：恢复时把屏外窗口收拢回可见工作区", () => {
  const persisted = {
    v: 2,
    windows: [
      { id: "off", appId: "off", kind: "app", bounds: { x: 5000, y: 500, w: 700, h: 500 } },
      { id: "ok", appId: "ok", kind: "app", bounds: { x: 100, y: 100, w: 700, h: 500 } },
    ],
  };
  const back = manager.deserialize(persisted, [AREA]);
  const off = domain.byId(back, "off").bounds;
  assert.ok(off.x >= AREA.x && off.x + off.w <= AREA.x + AREA.width, `屏外窗口未被收拢：x=${off.x}`);
  // 已可见的窗口不该被无谓改动
  assert.deepEqual(domain.byId(back, "ok").bounds, { x: 100, y: 100, w: 700, h: 500 });
});

test("坏数据一律降级：无数值、错误类型、重复 id、缺字段", () => {
  const cases = [
    [null, 0],
    [undefined, 0],
    ["{not json", 0],
    [42, 0],
    [{}, 0],
    [{ windows: null }, 0],
    [{ windows: [1, "x", null, [], { id: "" }, { id: 5 }] }, 0],
    [{ windows: [{ id: "a" }, { id: "a" }] }, 1],
  ];
  for (const [input, expected] of cases) {
    const back = manager.deserialize(input, [AREA]);
    assert.equal(back.windows.length, expected, `输入 ${JSON.stringify(input)} 恢复数量不对`);
    assert.deepEqual(domain.invariants(back), []);
  }
});

test("坏字段降级而不是让整条恢复失败：坏 bounds / 坏 state / 坏 minSize", () => {
  const back = manager.deserialize(
    {
      v: 2,
      windows: [
        { id: "a", appId: "a", bounds: { x: "x", y: null, w: 0, h: -1 }, state: "wat", minSize: { w: "no" } },
      ],
    },
    [AREA],
  );
  assert.equal(back.windows.length, 1, "单个字段坏掉不该丢掉整个窗口");
  const w = domain.byId(back, "a");
  assert.equal(w.state, domain.WSTATE.NORMAL);
  assert.equal(w.bounds.w, domain.MIN_WINDOW_W);
  assert.equal(w.bounds.h, domain.MIN_WINDOW_H);
  assert.equal(w.minSize.w, domain.MIN_WINDOW_W);
  assert.deepEqual(domain.invariants(back), []);
});

test("持久化路径只有 Window Manager 一条：domain 自己不做 IO", () => {
  // 反证：把 serialize 的结果直接喂回 deserialize，跨反复多轮仍稳定（不动点）
  let state = manager.applyAll(domain.createState(), [
    { type: "window/open", appId: "home", bounds: { x: 90, y: 94, w: 830, h: 570 } },
    { type: "window/open", appId: "files", bounds: { x: 200, y: 200, w: 700, h: 500 } },
    { type: "window/maximize", id: "files", host: HOST },
  ]);
  let json = manager.serialize(state);
  for (let i = 0; i < 5; i += 1) {
    const next = manager.deserialize(JSON.parse(json), [AREA]);
    const nextJson = manager.serialize(next);
    assert.equal(nextJson, json, `第 ${i + 1} 轮往返后持久化内容发生变化（不是不动点）`);
    json = nextJson;
  }
});

test("isPersistable：调用方用它决定「要不要回退默认」，而不是自己判结构", () => {
  assert.equal(domain.isPersistable({ v: 2, windows: [] }), true);
  assert.equal(domain.isPersistable({ windows: "no" }), false);
  assert.equal(domain.isPersistable(null), false);
  // 空 windows 数组是合法的（用户关掉了所有窗口），应被信任而不是回退默认
  const back = manager.deserialize({ v: 2, windows: [] }, [AREA]);
  assert.deepEqual(back.windows, []);
});
