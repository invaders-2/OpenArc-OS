/**
 * D5-02 · 保存冲突的三方合并（纯函数）。
 *
 * 测的就是**被 vendor 脚本内联进 public/novai-canvas/static/js/canvas.js 的那份文本**
 * （experiments/d5-02/vendor/canvas-merge.js）——不是影子实现：页面 409 分支调用同一份代码。
 * 这里只钉一件事：**两边内容都不许被静默丢掉**（要么都保留，要么远端那一版变成可辨认副本）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
const SRC = path.join(ROOT, "experiments", "d5-02", "vendor", "canvas-merge.js");
const source = fs.readFileSync(SRC, "utf8");
/** 与 canvas.js 里同一段文本：按 CJS 分支求值，拿到模块对象。*/
const merge = new Function("module", "window", source + "\n; return __openarcCanvasMerge;")({ exports: {} }, undefined);

const node = (id, extra = {}) => ({ id, type: "prompt", x: 0, y: 0, text: id, ...extra });
const edge = (id, from, to) => ({ id, from, to });
const doc = (nodes = [], connections = [], logs = []) => ({ nodes, connections, logs, title: "画布", icon: "🧩" });
const ids = (list) => list.map((item) => item.id).sort();
const byId = (list, id) => list.find((item) => item.id === id) || null;

test("只在一侧新增：两边的新增都保留，无冲突", () => {
  const base = doc([]);
  const local = doc([node("a")]);
  const remote = doc([node("b")]);
  const { doc: merged, report } = merge.mergeDocs(base, local, remote);
  assert.deepEqual(ids(merged.nodes), ["a", "b"]);
  assert.equal(report.conflicts.length, 0);
  assert.equal(report.copies.length, 0);
});

test("两侧都改不同节点：各自保留", () => {
  const base = doc([node("a"), node("b")]);
  const local = doc([node("a", { text: "本地改的 a" }), node("b")]);
  const remote = doc([node("a"), node("b", { text: "远端改的 b" })]);
  const { doc: merged, report } = merge.mergeDocs(base, local, remote);
  assert.equal(byId(merged.nodes, "a").text, "本地改的 a");
  assert.equal(byId(merged.nodes, "b").text, "远端改的 b");
  assert.equal(report.conflicts.length, 0);
});

test("两侧都改同一节点的不同字段：字段级各自保留，不造副本", () => {
  const base = doc([node("a", { text: "原文", w: 200 })]);
  const local = doc([node("a", { text: "本地文本", w: 200 })]);
  const remote = doc([node("a", { text: "原文", w: 360 })]);
  const { doc: merged, report } = merge.mergeDocs(base, local, remote);
  assert.equal(byId(merged.nodes, "a").text, "本地文本");
  assert.equal(byId(merged.nodes, "a").w, 360);
  assert.equal(report.conflicts.length, 0);
  assert.equal(report.copies.length, 0);
});

test("同一字段两边都改了：本地留在原位，远端那一版作为可辨认副本保留", () => {
  const base = doc([node("a", { text: "原文" })]);
  const local = doc([node("a", { text: "本地文本" })]);
  const remote = doc([node("a", { text: "远端文本", x: 10, y: 20 })]);
  const { doc: merged, report } = merge.mergeDocs(base, local, remote);
  assert.equal(byId(merged.nodes, "a").text, "本地文本", "本地那一版留在原位");
  const copy = byId(merged.nodes, "a-remote");
  assert.ok(copy, "远端那一版必须还在（a-remote）");
  assert.equal(copy.text, "远端文本");
  assert.equal(copy[merge.COPY_MARK], "a");
  assert.equal(copy.x, 58, "副本并排偏移 48px，避免与原节点重叠");
  assert.deepEqual(report.conflicts, [{ kind: "node", id: "a", reason: "SAME_FIELD", fields: ["text"] }]);
  assert.deepEqual(report.copies, ["a-remote"]);
});

test("同一份远端版本重复合并：复用已有副本，不重复追加", () => {
  const base = doc([node("a", { text: "原文" })]);
  const local = doc([node("a", { text: "本地文本" })]);
  const remote = doc([node("a", { text: "远端文本" })]);
  const first = merge.mergeDocs(base, local, remote);
  const second = merge.mergeDocs(remote, first.doc, remote);
  assert.equal(second.doc.nodes.filter((n) => n.id.indexOf("a-remote") === 0).length, 1);
  assert.equal(byId(second.doc.nodes, "a").text, "本地文本");
  assert.equal(byId(second.doc.nodes, "a-remote").text, "远端文本");
});

test("一侧删除、另一侧未改 → 删除；远端删除而本地改了 → 本地内容保留", () => {
  const base = doc([node("a"), node("b")]);
  const local = doc([node("b", { text: "本地改过" })]);                        // a：本地删；b：本地改
  const remote = doc([node("a", { text: "本地改过" })]);                        // a：远端改了；b：远端删
  const { doc: merged, report } = merge.mergeDocs(base, local, remote);
  assert.deepEqual(ids(merged.nodes), ["a-remote", "b"]);
  assert.equal(byId(merged.nodes, "b").text, "本地改过", "远端删除不带内容，本地改过的保留");
  assert.deepEqual(report.copies, ["a-remote"], "本地删除、远端改了 → 远端那一版另存副本");
  assert.equal(byId(merged.nodes, "a-remote").text, "本地改过");
  assert.equal(report.conflicts.filter((c) => c.reason === "LOCAL_DELETED_REMOTE_CHANGED").length, 1);
  assert.equal(report.conflicts.filter((c) => c.reason === "REMOTE_DELETED").length, 1);
});

test("两边都删 → 删除；两边都新增同一个 id 且内容相同 → 只留一份", () => {
  const base = doc([node("gone")]);
  const local = doc([node("same")]);
  const remote = doc([node("same")]);
  const { doc: merged, report } = merge.mergeDocs(base, local, remote);
  assert.deepEqual(ids(merged.nodes), ["same"]);
  assert.equal(report.conflicts.length, 0);
  assert.deepEqual(report.bothDeleted, ["node:gone"]);
});

test("连线按 id 走同一套规则：远端单方改动生效、远端新增保留、同字段冲突留副本", () => {
  const nodes = [node("a"), node("b"), node("c"), node("d")];
  const base = doc(nodes, [edge("e1", "a", "b"), edge("e2", "b", "c")]);
  const local = doc(nodes, [edge("e1", "a", "c"), edge("e2", "b", "c")]);
  const remote = doc(nodes, [edge("e1", "a", "d"), edge("e2", "b", "d"), edge("e3", "a", "d")]);
  const { doc: merged, report } = merge.mergeDocs(base, local, remote);
  assert.equal(byId(merged.connections, "e1").to, "c", "同一字段（to）两边都改了：本地那一版留在原位");
  assert.equal(byId(merged.connections, "e1-remote").to, "d", "远端那一版另存副本");
  assert.equal(byId(merged.connections, "e2").to, "d", "只有远端改了的连线用远端版本");
  assert.equal(byId(merged.connections, "e3").from, "a", "远端新增保留");
  assert.deepEqual(report.copies, ["e1-remote"]);
});

test("日志按 id 取并集（远端新条目保留），同 id 冲突不造副本", () => {
  const base = doc([], [], [{ id: "l1", at: 1, text: "基线" }]);
  const local = doc([], [], [{ id: "l2", at: 2, text: "本地" }, { id: "l1", at: 1, text: "基线" }]);
  const remote = doc([], [], [{ id: "l3", at: 3, text: "远端" }, { id: "l1", at: 1, text: "基线" }]);
  const { doc: merged, report } = merge.mergeDocs(base, local, remote);
  assert.deepEqual(ids(merged.logs), ["l1", "l2", "l3"]);
  assert.equal(report.copies.length, 0);
});

test("画布标题两边都改：本地标题留在原位，远端标题进报告（不静默丢）", () => {
  const base = doc([]);
  base.title = "原标题";
  const local = doc([]); local.title = "本地标题";
  const remote = doc([]); remote.title = "远端标题";
  const { doc: merged, report } = merge.mergeDocs(base, local, remote);
  assert.equal(merged.title, "本地标题");
  assert.equal(report.remoteTitle, "远端标题");
  assert.deepEqual(report.conflicts.filter((c) => c.kind === "canvas"), [{ kind: "canvas", id: "", reason: "SAME_FIELD", fields: ["title"] }]);
});

test("没有任何改动时：结果与本地文档逐字段相等（不制造假冲突）", () => {
  const base = doc([node("a", { text: "x" })], [edge("e1", "a", "a")]);
  const local = JSON.parse(JSON.stringify(base));
  const remote = JSON.parse(JSON.stringify(base));
  const { doc: merged, report } = merge.mergeDocs(base, local, remote);
  assert.equal(merge.canon(merged), merge.canon(local));
  assert.equal(report.conflicts.length, 0);
  assert.equal(report.copies.length, 0);
});

test("键序不同不算改动（服务端 JSON 往返不保证键序）", () => {
  const base = doc([{ id: "a", type: "prompt", x: 0, y: 0, text: "t" }]);
  const local = doc([{ text: "t", y: 0, x: 0, type: "prompt", id: "a" }]);
  const remote = doc([{ id: "a", text: "t", type: "prompt", y: 0, x: 0 }]);
  const { doc: merged, report } = merge.mergeDocs(base, local, remote);
  assert.equal(report.conflicts.length, 0);
  assert.deepEqual(ids(merged.nodes), ["a"]);
});
