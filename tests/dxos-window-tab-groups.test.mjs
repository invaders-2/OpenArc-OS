/**
 * task-21 后端 · 窗口标签组（tabGroupId）：合并 / 拆分 / 切换 / 关闭 / 几何继承与恢复 / 持久化 / IPC 批处理。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const domain = require("../electron/window-domain.ts");
const manager = require("../electron/window-manager.ts");
const { applyWindowCommandBatch, MAX_WINDOW_COMMANDS } = require("../electron/window-command-ipc.cjs");

const HOST = { width: 1440, height: 940 };
const W = domain.WSTATE;
const open = (id, appId, bounds) => ({ type: "window/open", id, appId, bounds, meta: { title: id } });
const boot = (commands) => manager.applyAll(domain.createState(), commands);

function notesState() {
  return boot([
    open("notes:1", "notes", { x: 100, y: 100, w: 800, h: 600 }),
    open("notes:2", "notes", { x: 200, y: 150, w: 700, h: 500 }),
    open("settings", "settings", { x: 300, y: 200, w: 650, h: 450 }),
  ]);
}
const groupOf = (state, id) => domain.tabGroupOfWindow(state, id);
const merge = (state, ids, extra = {}) => manager.reduce(state, { type: "window/tab-group-merge", ids, ...extra });
const split = (state, extra = {}) => manager.reduce(state, { type: "window/tab-group-split", ...extra });
const activate = (state, id) => manager.reduce(state, { type: "window/tab-group-activate", id });

test("① 合并：同应用多窗口成一个组；组几何继承 active；只有 active 可见", () => {
  const state = notesState();
  const merged = merge(state, ["notes:1", "notes:2"]);
  const group = groupOf(merged, "notes:1");
  assert.ok(group, "必须形成组");
  assert.equal(group.id, groupOf(merged, "notes:2").id);
  assert.equal(group.appId, "notes");
  assert.equal(group.activeWindowId, "notes:2", "默认 active = 当前聚焦");
  const w1 = domain.byId(merged, "notes:1");
  const w2 = domain.byId(merged, "notes:2");
  assert.deepEqual(w1.bounds, w2.bounds, "所有成员继承同一组几何");
  assert.deepEqual(w2.bounds, state.windows.find((w) => w.id === "notes:2").bounds, "active 几何 = 合并前 bounds");
  assert.deepEqual(w1.tabRestore.bounds, { x: 100, y: 100, w: 800, h: 600 }, "合并前几何必须留档");
  assert.equal(w1.visible, false);
  assert.equal(w2.visible, true);
  assert.deepEqual(domain.invariants(merged), []);
  assert.equal(merged.focused, "notes:2");
});

test("① 合并边界：跨应用 / 已分组未显式 groupId / 单窗口 一律 no-op", () => {
  const state = notesState();
  assert.equal(merge(state, ["notes:1", "settings"]), state, "跨应用不得合并");
  const merged = merge(state, ["notes:1", "notes:2"]);
  assert.equal(merge(merged, ["settings", "notes:1"]), merged, "已分组成员不能隐式并组");
  assert.equal(merge(merged, ["notes:1"]), merged, "单窗口不能成组");
});

test("② 手动并入已有组：追加成员并继承组几何；组 active 不变", () => {
  const state = notesState();
  const merged = merge(state, ["notes:1", "notes:2"]);
  const groupId = groupOf(merged, "notes:1").id;
  const withThird = boot([open("notes:3", "notes", { x: 500, y: 300, w: 640, h: 480 })]);
  // 用同一状态再打开第三个
  const three = manager.reduce(merged, open("notes:3", "notes", { x: 500, y: 300, w: 640, h: 480 }));
  const added = merge(three, ["notes:3"], { groupId, activeId: "notes:1" });
  assert.equal(groupOf(added, "notes:3").id, groupId);
  assert.equal(groupOf(added, "notes:3").activeWindowId, "notes:1");
  assert.deepEqual(domain.byId(added, "notes:3").bounds, domain.byId(added, "notes:1").bounds);
  assert.deepEqual(domain.invariants(added), []);
  assert.equal(withThird.windows.length, 1);
});

test("② 同应用自动合并：只并当前 App，其它 App 不动", () => {
  const state = notesState();
  const auto = manager.reduce(state, { type: "window/tab-group-auto", appId: "notes" });
  assert.ok(groupOf(auto, "notes:1"));
  assert.ok(groupOf(auto, "notes:2"));
  assert.equal(domain.byId(auto, "settings").tabGroupId, null);
  assert.equal(merge(state, []).windows.length, 3);
});

test("③ 切换：active / focused / 可见性 / 几何全部同步；组外窗口不受影响", () => {
  const state = notesState();
  const merged = merge(state, ["notes:1", "notes:2"]);
  const switched = activate(merged, "notes:1");
  assert.equal(groupOf(switched, "notes:1").activeWindowId, "notes:1");
  assert.equal(switched.focused, "notes:1");
  assert.equal(domain.byId(switched, "notes:1").visible, true);
  assert.equal(domain.byId(switched, "notes:2").visible, false);
  assert.equal(switched.order[switched.order.length - 1], "notes:1");
  assert.equal(domain.byId(switched, "settings").visible, true);
  assert.deepEqual(domain.invariants(switched), []);
});

test("④ 拆分单个：>2 保留组并恢复被拆成员几何；2 个成员拆分即解散", () => {
  const state = notesState();
  const merged = merge(state, ["notes:1", "notes:2"]);
  const groupId = groupOf(merged, "notes:1").id;
  const three = manager.reduce(merged, open("notes:3", "notes", { x: 600, y: 350, w: 620, h: 460 }));
  const withThree = merge(three, ["notes:3"], { groupId });
  const removed = split(withThree, { id: "notes:3" });
  assert.equal(domain.byId(removed, "notes:3").tabGroupId, null);
  assert.deepEqual(domain.byId(removed, "notes:3").bounds, { x: 600, y: 350, w: 620, h: 460 }, "拆出恢复原几何");
  assert.ok(groupOf(removed, "notes:1"));
  assert.equal(domain.windowsOfTabGroup(removed, groupId).length, 2);

  const dissolved = split(merged, { id: "notes:1" });
  assert.equal(domain.byId(dissolved, "notes:1").tabGroupId, null);
  assert.equal(domain.byId(dissolved, "notes:2").tabGroupId, null);
  assert.deepEqual(domain.byId(dissolved, "notes:1").bounds, { x: 100, y: 100, w: 800, h: 600 });
  assert.deepEqual(domain.byId(dissolved, "notes:2").bounds, { x: 200, y: 150, w: 700, h: 500 });
  assert.deepEqual(dissolved.tabGroups, {});
});

test("④ 拆分整组：全部恢复合并前几何；几何字段继承与恢复都是深拷贝", () => {
  const state = notesState();
  const merged = merge(state, ["notes:1", "notes:2"]);
  const splitAll = split(merged, { groupId: groupOf(merged, "notes:1").id });
  assert.equal(domain.byId(splitAll, "notes:1").tabGroupId, null);
  assert.equal(domain.byId(splitAll, "notes:2").tabGroupId, null);
  assert.deepEqual(domain.byId(splitAll, "notes:1").bounds, { x: 100, y: 100, w: 800, h: 600 });
  assert.notEqual(domain.byId(splitAll, "notes:1").bounds, domain.byId(merged, "notes:1").bounds);
  assert.deepEqual(splitAll.windows.map((w) => w.id).sort(), state.windows.map((w) => w.id).sort());
});

test("⑤ 关闭：关 active 自动切下一个；剩下 1 个自动拆组；关整组全关", () => {
  const state = notesState();
  const merged = merge(state, ["notes:1", "notes:2"]);
  const closedActive = manager.reduce(merged, { type: "window/close", id: "notes:2" });
  assert.equal(domain.byId(closedActive, "notes:1").tabGroupId, null, "最后 1 个成员自动拆组");
  assert.deepEqual(domain.byId(closedActive, "notes:1").bounds, { x: 100, y: 100, w: 800, h: 600 });
  assert.equal(closedActive.focused, "notes:1");
  assert.deepEqual(closedActive.tabGroups, {});

  const groupClose = manager.reduce(merged, { type: "window/tab-group-close", groupId: groupOf(merged, "notes:1").id });
  assert.equal(domain.byId(groupClose, "notes:1"), null);
  assert.equal(domain.byId(groupClose, "notes:2"), null);
  assert.ok(domain.byId(groupClose, "settings"));
  assert.deepEqual(domain.invariants(groupClose), []);
});

test("⑥ 几何：组内移动/缩放/最大化同步全部成员；minimize 整组", () => {
  const state = notesState();
  const merged = merge(state, ["notes:1", "notes:2"]);
  const moved = manager.reduce(merged, { type: "window/move", id: "notes:1", x: 300, y: 200, host: HOST });
  assert.deepEqual(domain.byId(moved, "notes:1").bounds, domain.byId(moved, "notes:2").bounds);
  const resized = manager.reduce(moved, { type: "window/resize", id: "notes:1", w: 900, h: 700, host: HOST });
  assert.deepEqual(domain.byId(resized, "notes:1").bounds, domain.byId(resized, "notes:2").bounds);
  const max = manager.reduce(resized, { type: "window/maximize", id: "notes:1", host: HOST });
  assert.equal(domain.byId(max, "notes:1").state, W.MAXIMIZED);
  assert.equal(domain.byId(max, "notes:2").state, W.MAXIMIZED);
  assert.deepEqual(domain.byId(max, "notes:1").bounds, domain.byId(max, "notes:2").bounds);
  const restored = manager.reduce(max, { type: "window/unmaximize", id: "notes:1" });
  assert.deepEqual(domain.byId(restored, "notes:1").bounds, domain.byId(restored, "notes:2").bounds);
  const minimized = manager.reduce(restored, { type: "window/minimize", id: "notes:1" });
  assert.equal(domain.byId(minimized, "notes:1").state, W.MINIMIZED);
  assert.equal(domain.byId(minimized, "notes:2").state, W.MINIMIZED);
});

test("⑦ 持久化：tabGroupId / 组 / active / 几何往返；坏组数据降级为拆组", () => {
  const state = notesState();
  const merged = merge(state, ["notes:1", "notes:2"]);
  const persisted = domain.toPersisted(merged);
  const restored = manager.deserialize(persisted);
  assert.equal(groupOf(restored, "notes:1").activeWindowId, "notes:2");
  assert.deepEqual(domain.byId(restored, "notes:1").bounds, domain.byId(merged, "notes:1").bounds);
  assert.deepEqual(domain.invariants(restored), []);
  assert.deepEqual(JSON.parse(manager.serialize(restored)).tabGroups, persisted.tabGroups);

  const broken = JSON.parse(JSON.stringify(persisted));
  for (const w of broken.windows) if (w.tabGroupId) w.tabGroupId = "tg:missing";
  const degraded = manager.deserialize(broken);
  assert.equal(degraded.windows.every((w) => w.tabGroupId === null), true, "坏引用必须降级为拆组");
  assert.deepEqual(degraded.tabGroups, {});
});

test("⑧ 原生视图：标签组只保留 active 成员的 native intent", () => {
  const state = boot([
    open("browser:1", "browser", { x: 100, y: 100, w: 900, h: 600 }),
    open("browser:2", "browser", { x: 150, y: 130, w: 900, h: 600 }),
    open("browser:3", "browser", { x: 200, y: 160, w: 900, h: 600 }),
  ]);
  const merged = merge(state, ["browser:1", "browser:2", "browser:3"]);
  const active = groupOf(merged, "browser:1").activeWindowId;
  const intents = manager.nativeIntents(merged, HOST);
  assert.deepEqual(intents.map((intent) => intent.windowId), [active]);
  assert.equal(intents[0].present, true);
});

test("⑨ IPC 批处理：persisted state + 命令 → 新状态；未知命令 rejected；坏输入结构化", () => {
  const state = notesState();
  const persisted = domain.toPersisted(state);
  const created = applyWindowCommandBatch({
    state: persisted,
    commands: [{ type: "window/tab-group-merge", ids: ["notes:1", "notes:2"] }],
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(created.changed, true);
  assert.equal(created.accepted[0].changed, true);
  assert.equal(created.state.focused, "notes:2");
  assert.ok(created.persisted.tabGroups[groupOf(created.state, "notes:1").id]);

  const splitResult = applyWindowCommandBatch({
    state: created.persisted,
    commands: [{ type: "window/tab-group-split", groupId: groupOf(created.state, "notes:1").id }],
  });
  assert.equal(splitResult.ok, true);
  assert.deepEqual(splitResult.persisted.tabGroups, {});

  const unknown = applyWindowCommandBatch({ state: persisted, commands: [{ type: "window/nope" }] });
  assert.equal(unknown.ok, true);
  assert.equal(unknown.changed, false);
  assert.equal(unknown.rejected[0].reason, "unknown-command");

  assert.equal(applyWindowCommandBatch({ state: null, commands: [] }).error, "WINDOW_STATE_INVALID");
  assert.equal(applyWindowCommandBatch({ state: persisted, commands: "x" }).error, "WINDOW_COMMANDS_INVALID");
  assert.equal(applyWindowCommandBatch({ state: persisted, commands: Array.from({ length: MAX_WINDOW_COMMANDS + 1 }, () => ({ type: "window/focus", id: "notes:1" })) }).error, "WINDOW_COMMANDS_TOO_MANY");
});

test("⑩ 契约：9 条 Window Command 不变；标签组命令独立登记；main 走既有 windows:sync", () => {
  assert.equal(manager.WINDOW_COMMANDS.length, 9);
  assert.deepEqual([...manager.WINDOW_COMMANDS].sort(), [
    "window/close", "window/focus", "window/maximize", "window/minimize", "window/move",
    "window/open", "window/resize", "window/restore", "window/unmaximize",
  ].sort());
  assert.equal(manager.TAB_GROUP_COMMANDS.length, 5);
  for (const type of manager.TAB_GROUP_COMMANDS) {
    assert.equal(typeof manager.REDUCERS[type], "function", type);
    assert.equal(manager.WINDOW_COMMANDS.includes(type), false);
  }
  const main = fs.readFileSync(path.join(process.cwd(), "electron", "window-browser-ipc.cjs"), "utf8");
  assert.ok(main.includes('require("./window-command-ipc.cjs")'));
  assert.ok(main.includes("applyWindowCommandBatch({"));
  assert.ok(main.includes("windowBatch"));
  const preload = fs.readFileSync(path.join(process.cwd(), "electron", "preload.cjs"), "utf8");
  assert.ok(preload.includes('ipcRenderer.invoke("windows:sync", payload)'), "沿用既有 sync 通道，不新增 preload 成员");
});
