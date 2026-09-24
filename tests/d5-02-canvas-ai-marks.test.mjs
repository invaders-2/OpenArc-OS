/**
 * D5-02 · 画布「AI 新增」来源标记 / 入场动画（纯函数）。
 *
 * 测的就是**被 vendor 脚本内联进 public/novai-canvas/static/js/canvas.js 的那份文本**
 * （experiments/d5-02/vendor/canvas-ai-marks.js）——不是影子实现：页面标记与淡入判定调用同一份代码。
 * 这里只钉三件事：① 只有账本里**确实是 AI（AGENT）新增**的 id 才进标记集合；
 * ② 已经播过入场动画的 id 不会因为下一次远端同步再播一遍；③ 形状不对的回包不猜、不抛。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
const SRC = path.join(ROOT, "experiments", "d5-02", "vendor", "canvas-ai-marks.js");
const source = fs.readFileSync(SRC, "utf8");
/** 与 canvas.js 里同一段文本：按 CJS 分支求值，拿到模块对象。*/
const marks = new Function("module", "window", source + "\n; return __openarcCanvasAiMarks;")({ exports: {} }, undefined);

/** 宿主回包（CanvasHost 的 canvas.agentMarks）：一条账本条目 = 一条已应用的 AI 命令。*/
const add = (nodeIds, extra = {}) => ({ nodeIds, edgeIds: [], commandType: "node.add", resultRevision: 7, at: 1700000000000, ...extra });

test("第一条 AI 新增：既进标记集合，也进本次入场动画", () => {
  const p = marks.plan({ marks: [add(["a"])] }, { nodeIds: [], edgeIds: [] });
  assert.deepEqual(p.marked.nodeIds, ["a"]);
  assert.deepEqual(p.enter.nodeIds, ["a"]);
  assert.deepEqual(p.marked.edgeIds, []);
});

test("同一条回包再来一次（连续两次远端同步）：不再重播入场动画，标记仍在", () => {
  const first = marks.plan({ marks: [add(["a"])] }, { nodeIds: [], edgeIds: [] });
  const second = marks.plan({ marks: [add(["a"])] }, first.seen);
  assert.deepEqual(second.marked.nodeIds, ["a"]);
  assert.deepEqual(second.enter.nodeIds, []);
  const third = marks.plan({ marks: [add(["a"])] }, second.seen);
  assert.deepEqual(third.enter.nodeIds, []);
});

test("多个 AI 节点：只播这次新出现的那些（已播过的不再播）", () => {
  const first = marks.plan({ marks: [add(["a"])] }, { nodeIds: [], edgeIds: [] });
  const second = marks.plan({ marks: [add(["a"]), add(["b"])] }, first.seen);
  assert.deepEqual(second.marked.nodeIds, ["a", "b"]);
  assert.deepEqual(second.enter.nodeIds, ["b"]);
});

test("用户新增 / 别的窗口的用户操作：账本里没有 AGENT 条目 → 回包为空 → 不标不播", () => {
  const p = marks.plan({ marks: [] }, { nodeIds: [], edgeIds: [] });
  assert.deepEqual(p.marked, { nodeIds: [], edgeIds: [] });
  assert.deepEqual(p.enter, { nodeIds: [], edgeIds: [] });
  assert.deepEqual(p.seen, { nodeIds: [], edgeIds: [] });
});

test("AI 改过（node.edit）但由用户新增的节点：条目里没有 nodeIds → 不进标记（不误标）", () => {
  const p = marks.plan({ marks: [{ nodeIds: [], edgeIds: [], commandType: "node.edit", resultRevision: 9, at: 1 }] }, { nodeIds: [], edgeIds: [] });
  assert.deepEqual(p.marked.nodeIds, []);
  assert.deepEqual(p.enter.nodeIds, []);
});

test("同一条回包里同一个 id 出现多次：只标一次、只播一次", () => {
  const p = marks.plan({ marks: [add(["a", "a"]), add(["a"])] }, { nodeIds: [], edgeIds: [] });
  assert.deepEqual(p.marked.nodeIds, ["a"]);
  assert.deepEqual(p.enter.nodeIds, ["a"]);
  assert.deepEqual(p.seen.nodeIds, ["a"]);
});

test("连线（edgeIds）走同一套：标记与入场各自去重", () => {
  const p = marks.plan({ marks: [{ nodeIds: [], edgeIds: ["e1"], commandType: "edge.connect", resultRevision: 3, at: 5 }] }, { nodeIds: [], edgeIds: [] });
  assert.deepEqual(p.marked.edgeIds, ["e1"]);
  assert.deepEqual(p.enter.edgeIds, ["e1"]);
  const again = marks.plan({ marks: [{ nodeIds: [], edgeIds: ["e1"] }] }, p.seen);
  assert.deepEqual(again.marked.edgeIds, ["e1"]);
  assert.deepEqual(again.enter.edgeIds, []);
});

test("seen 可以给数组 / Set / 对象键：三种都认（元素重建/换画布后重新装载同一份集合）", () => {
  for (const seen of [{ nodeIds: ["a"], edgeIds: [] }, { nodeIds: new Set(["a"]), edgeIds: [] }, { nodeIds: { a: true }, edgeIds: {} }]) {
    const p = marks.plan({ marks: [add(["a"])] }, seen);
    assert.deepEqual(p.enter.nodeIds, []);
  }
});

test("形状不对的回包：不抛、不猜（缺 marks / marks 不是数组 / 条目不是对象 / id 非字符串）", () => {
  for (const payload of [null, undefined, {}, { marks: null }, { marks: "x" }, { marks: [null, 7, "a"] }, { marks: [{ nodeIds: [3, "", null, {}] }] }]) {
    const p = marks.plan(payload, { nodeIds: [], edgeIds: [] });
    assert.equal(Array.isArray(p.marked.nodeIds), true);
    assert.equal(Array.isArray(p.enter.nodeIds), true);
  }
  const numeric = marks.plan({ marks: [{ nodeIds: [3] }] }, { nodeIds: [], edgeIds: [] });
  assert.deepEqual(numeric.marked.nodeIds, ["3"]);
});

test("归一化：只保留 { nodeIds, edgeIds, commandType, resultRevision, at }，其它字段一律不带出", () => {
  const rows = marks.sanitize({ marks: [{ nodeIds: ["a"], edgeIds: ["e"], commandType: "node.add", resultRevision: "12", at: "34", text: "AI 写的正文", prompt: "秘密", url: "openarc-asset:x", node: { id: "a" } }] });
  assert.deepEqual(Object.keys(rows[0]).sort(), ["at", "commandType", "edgeIds", "nodeIds", "resultRevision"]);
  assert.equal(rows[0].resultRevision, 12);
  assert.equal(JSON.stringify(rows).includes("秘密"), false);
  assert.equal(rows[0].nodeIds.length, 1);
});

test("有界：单条 id 列表与条目数都被截断", () => {
  const many = Array.from({ length: 500 }, (_, i) => "n" + i);
  const rows = marks.sanitize({ marks: [{ nodeIds: many }] });
  assert.equal(rows[0].nodeIds.length, marks.MAX_IDS);
  const lots = Array.from({ length: 400 }, (_, i) => ({ nodeIds: ["n" + i] }));
  assert.equal(marks.sanitize({ marks: lots }).length, marks.MAX_MARKS);
});
