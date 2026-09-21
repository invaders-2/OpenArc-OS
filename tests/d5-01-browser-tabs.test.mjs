/**
 * D5-01 · 浏览器标签领域/管理器契约（product 真实模块，非等价物）。
 *
 * 覆盖：标签模型归一化（含 D5-01 之前的旧持久化形状）/ 四条 browser/* 命令 /
 * 不变量 / 上限 / no-op 的引用语义 / nativeIntents 的每标签视图 / 持久化往返。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const domain = require("../electron/window-domain.cjs");
const manager = require("../electron/window-manager.cjs");

const HOST = { width: 1440, height: 940 };
const boot = (cmds) => manager.applyAll(domain.createState(), cmds);
const browserWin = (state) => domain.byId(state, "browser");
const tabs = (state) => domain.tabsOf(browserWin(state));

test("标签模型：浏览器窗口恒有标签；非浏览器窗口没有标签字段", () => {
  const state = boot([
    { type: "window/open", appId: "browser", id: "browser", bounds: { x: 60, y: 80, w: 700, h: 500 } },
    { type: "window/open", appId: "home", id: "home" },
  ]);
  assert.equal(tabs(state).length, 1, "新浏览器窗口必须自带一个标签");
  assert.equal(domain.activeTabIdOf(browserWin(state)), tabs(state)[0].tabId);
  assert.deepEqual(browserWin(state).meta.tabs, [{ tabId: "t1", url: "", title: "" }]);
  assert.equal(domain.byId(state, "home").meta.tabs, undefined, "非浏览器窗口不得被塞进标签字段");
  assert.deepEqual(domain.invariants(state), []);
});

test("旧持久化（只有 meta.url）恢复成单标签，不丢地址", () => {
  const persisted = { v: 2, windows: [{ id: "browser", appId: "browser", kind: "browser", bounds: { x: 10, y: 60, w: 800, h: 600 }, state: "normal", restore: null, minSize: { w: 560, h: 400 }, meta: { title: "浏览器", icon: "safari", url: "https://example.com/old" }, displayId: null }] };
  const state = manager.deserialize(persisted, [manager.areaOf(HOST)]);
  assert.deepEqual(domain.tabsOf(browserWin(state)), [{ tabId: "t1", url: "https://example.com/old", title: "" }]);
  assert.equal(browserWin(state).meta.url, "https://example.com/old");
  assert.deepEqual(domain.invariants(state), []);
});

test("browser/tab-open / activate / close：命令语义与不变量", () => {
  let state = boot([{ type: "window/open", appId: "browser", id: "browser", bounds: { x: 60, y: 80, w: 700, h: 500 } }]);
  state = manager.reduce(state, { type: "browser/tab-open", id: "browser", tabId: "t2", url: "https://b.example/" });
  assert.equal(tabs(state).length, 2);
  assert.equal(browserWin(state).meta.activeTabId, "t2", "新标签必须成为活动标签");
  assert.equal(browserWin(state).meta.url, "https://b.example/", "meta.url 必须跟随活动标签");
  assert.deepEqual(domain.invariants(state), []);

  // 重复 tabId / 空 tabId → 不改状态（同一引用）
  assert.equal(manager.reduce(state, { type: "browser/tab-open", id: "browser", tabId: "t2", url: "https://x/" }), state);
  assert.equal(manager.reduce(state, { type: "browser/tab-open", id: "browser", tabId: "", url: "https://x/" }), state);

  state = manager.reduce(state, { type: "browser/tab-activate", id: "browser", tabId: "t1" });
  assert.equal(browserWin(state).meta.activeTabId, "t1");
  assert.equal(browserWin(state).meta.url, "", "切换后 meta.url 必须是新活动标签的 url");
  assert.equal(manager.reduce(state, { type: "browser/tab-activate", id: "browser", tabId: "t1" }), state, "重复激活必须是 no-op");

  state = manager.reduce(state, { type: "browser/tab-close", id: "browser", tabId: "t2" });
  assert.equal(tabs(state).length, 1);
  assert.equal(browserWin(state).meta.activeTabId, "t1");
  assert.deepEqual(domain.invariants(state), []);
  // 最后一个标签不在这里关（浏览器语义 = 关窗口）
  assert.equal(manager.reduce(state, { type: "browser/tab-close", id: "browser", tabId: "t1" }), state);
});

test("活动标签被关闭：激活邻居；持久化往返保留 tabs / activeTabId / tabSeq", () => {
  let state = boot([{ type: "window/open", appId: "browser", id: "browser", bounds: { x: 60, y: 80, w: 700, h: 500 } }]);
  for (const [tabId, url] of [["t2", "https://two.example/"], ["t3", "https://three.example/"]])
    state = manager.reduce(state, { type: "browser/tab-open", id: "browser", tabId, url });
  state = manager.reduce(state, { type: "browser/tab-activate", id: "browser", tabId: "t2" });
  state = manager.reduce(state, { type: "browser/tab-close", id: "browser", tabId: "t2" });
  assert.deepEqual(tabs(state).map((t) => t.tabId), ["t1", "t3"]);
  assert.equal(browserWin(state).meta.activeTabId, "t3", "关掉活动标签后必须激活邻居");

  const round = manager.deserialize(JSON.parse(manager.serialize(state)), [manager.areaOf(HOST)]);
  assert.deepEqual(domain.tabsOf(browserWin(round)), tabs(state));
  assert.equal(browserWin(round).meta.activeTabId, "t3");
  assert.equal(browserWin(round).meta.tabSeq, browserWin(state).meta.tabSeq);
  assert.deepEqual(domain.invariants(round), []);
});

test("TAB_LIMIT：到达上限后 tab-open 不改状态；invariants 不接受超限", () => {
  let state = boot([{ type: "window/open", appId: "browser", id: "browser", bounds: { x: 60, y: 80, w: 700, h: 500 } }]);
  for (let i = 2; i <= domain.TAB_LIMIT; i += 1)
    state = manager.reduce(state, { type: "browser/tab-open", id: "browser", tabId: "t" + i, url: "https://e.example/" + i });
  assert.equal(tabs(state).length, domain.TAB_LIMIT);
  const atLimit = manager.reduce(state, { type: "browser/tab-open", id: "browser", tabId: "overflow", url: "https://o.example/" });
  assert.equal(atLimit, state, "上限之后必须原样返回原状态");
  // 归一化也会截断超限输入（坏持久化不得让原生视图数失控）
  const oversized = domain.normalizeBrowserMeta({ tabs: Array.from({ length: domain.TAB_LIMIT + 5 }, (_, i) => ({ tabId: "x" + i, url: "" })) });
  assert.equal(oversized.tabs.length, domain.TAB_LIMIT);
});

test("browser/tab-state：只改目标标签；活动标签标题成为窗口标题；无变化同一引用", () => {
  let state = boot([{ type: "window/open", appId: "browser", id: "browser", bounds: { x: 60, y: 80, w: 700, h: 500 } }]);
  state = manager.reduce(state, { type: "browser/tab-open", id: "browser", tabId: "t2", url: "https://b.example/" });
  state = manager.reduce(state, { type: "browser/tab-state", windowId: "browser", tabId: "t2", url: "https://b.example/page", title: "B 页" });
  assert.equal(browserWin(state).meta.title, "B 页");
  assert.equal(browserWin(state).meta.url, "https://b.example/page");
  assert.deepEqual(tabs(state)[0], { tabId: "t1", url: "", title: "" }, "非目标标签不得被改写");

  // 后台标签的标题不得改窗口标题
  state = manager.reduce(state, { type: "browser/tab-state", windowId: "browser", tabId: "t1", url: "https://a.example/", title: "A 页" });
  assert.equal(browserWin(state).meta.title, "B 页");
  assert.equal(tabs(state)[0].title, "A 页");

  const same = manager.reduce(state, { type: "browser/tab-state", windowId: "browser", tabId: "t2", url: "https://b.example/page", title: "B 页" });
  assert.equal(same, state, "无变化的标签状态回报必须返回同一引用");
  assert.equal(manager.reduce(state, { type: "browser/tab-state", windowId: "ghost", tabId: "t2" }), state);
  assert.deepEqual(domain.invariants(state), []);
});

test("system/native-state 对浏览器窗口走标签路径（meta.url 不会与活动标签漂移）", () => {
  let state = boot([{ type: "window/open", appId: "browser", id: "browser", bounds: { x: 60, y: 80, w: 700, h: 500 } }]);
  state = manager.reduce(state, { type: "system/native-state", windowId: "browser", url: "https://only.example/", title: "Only" });
  assert.deepEqual(tabs(state), [{ tabId: "t1", url: "https://only.example/", title: "Only" }]);
  assert.equal(browserWin(state).meta.url, "https://only.example/");
  assert.deepEqual(domain.invariants(state), []);
});

test("nativeIntents：每个标签一条视图意图，只有活动标签 active；视口与遮挡者不变", () => {
  let state = boot([
    { type: "window/open", appId: "browser", id: "browser", bounds: { x: 60, y: 80, w: 700, h: 500 } },
    { type: "window/open", appId: "home", id: "home", bounds: { x: 100, y: 120, w: 700, h: 500 } },
  ]);
  state = manager.reduce(state, { type: "browser/tab-open", id: "browser", tabId: "t2", url: "https://b.example/" });
  const [intent] = manager.nativeIntents(state, HOST);
  assert.deepEqual(intent.views.map((v) => [v.viewId, v.tabId, v.url, v.active]), [
    ["browser#t1", "t1", "", false],
    ["browser#t2", "t2", "https://b.example/", true],
  ]);
  assert.equal(intent.url, "https://b.example/", "窗口级 url = 活动标签 url（快照键口径）");
  assert.deepEqual(intent.viewport, {
    x: 60,
    y: 80 + domain.TITLE_BAR_H + domain.BROWSER_CHROME_H,
    width: 700,
    height: 500 - domain.TITLE_BAR_H - domain.BROWSER_CHROME_H,
  });
  assert.deepEqual(intent.occluders.map((o) => o.id), ["home"]);
  // 非原生窗口不产出意图（最小化后 present=false）
  assert.equal(manager.nativeIntents(manager.reduce(state, { type: "window/minimize", id: "browser" }), HOST)[0].present, false);
});

test("浏览器命令只作用于浏览器窗口：home / ghost 一律 no-op", () => {
  const state = boot([{ type: "window/open", appId: "home", id: "home" }]);
  for (const type of ["browser/tab-open", "browser/tab-close", "browser/tab-activate", "browser/tab-state"])
    assert.equal(manager.reduce(state, { type, id: "home", windowId: "home", tabId: "t1" }), state, type + " 不得作用于非浏览器窗口");
  assert.equal(manager.reduce(state, { type: "browser/tab-open", id: "ghost", tabId: "t1" }), state);
  assert.ok(manager.BROWSER_COMMANDS.includes("browser/tab-open"));
  assert.equal(manager.WINDOW_COMMANDS.length, 9, "窗口命令仍是冻结的 9 条");
});
