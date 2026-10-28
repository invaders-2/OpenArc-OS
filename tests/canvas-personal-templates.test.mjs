import test from "node:test";
import assert from "node:assert/strict";
import { templateDocument } from "../src/canvas/canvas-next/personalTemplates.ts";
import { newNode } from "../src/canvas/canvas-next/model.ts";

test("个人模板保留生成参数、文本、表格和有效连线", () => {
  const text = newNode("text", 0, 0, { id: "text", title: "需求", prompt: "分析卖点", hist: [{ text: "三个卖点" }], hi: 0 });
  const image = newNode("image", 300, 0, { id: "image", title: "海报", prompt: "制作海报", params: { ...newNode("image", 0, 0).data.gen.params, ratio: "3:4" } });
  const table = { id: "table", kind: "table", x: 600, y: 0, w: 420, h: 220, text: "表格", data: { table: { title: "任务表", columns: ["任务"], rows: [["海报"]], sourceId: "text" } } };
  const group = { id: "group", kind: "group", x: 0, y: 0, w: 500, h: 500, text: "分组" };
  const doc = templateDocument({ nodes: [text, image, table, group], edges: [{ id: "a", from: "text", to: "image" }, { id: "b", from: "group", to: "image" }] });
  assert.equal(doc.nodes.length, 3);
  assert.deepEqual(doc.edges.map((edge) => edge.id), ["a"]);
  assert.equal(doc.nodes[0].data.gen.hist[0].text, "三个卖点");
  assert.equal(doc.nodes[1].data.gen.params.ratio, "3:4");
  assert.equal(doc.nodes[2].data.table.title, "任务表");
  assert.equal(doc.nodes[2].data.table.sourceId, undefined);
  assert.equal(doc.nodes[1].data.gen.hist, undefined, "模板不带生成结果");
});
