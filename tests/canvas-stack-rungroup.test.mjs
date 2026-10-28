// 多节点堆叠、分组运行计划、批量下载 zip（TapNow 对齐）
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const esbuild = require("esbuild");
const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "node_modules/.cache/oa-canvas-stack-" + process.pid + ".mjs");
const ENTRY = path.join(ROOT, "node_modules/.cache/oa-canvas-stack-entry-" + process.pid + ".ts");
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(ENTRY, [
  `export * from ${JSON.stringify(path.join(ROOT, "src/canvas/canvas-next/stack.ts"))};`,
  `export * from ${JSON.stringify(path.join(ROOT, "src/canvas/canvas-next/zip.ts"))};`,
  `export { planGroup, callsOf } from ${JSON.stringify(path.join(ROOT, "src/canvas/canvas-next/engine.ts"))};`,
  `export { copySelection, paste, deleteSelection } from ${JSON.stringify(path.join(ROOT, "src/canvas/canvas-next/actions.ts"))};`,
  `export { CanvasStore } from ${JSON.stringify(path.join(ROOT, "src/canvas/canvas-next/store.ts"))};`,
  `export { newNode, specFor } from ${JSON.stringify(path.join(ROOT, "src/canvas/canvas-next/model.ts"))};`,
].join("\n"));
await esbuild.build({ entryPoints: [ENTRY], bundle: true, format: "esm", platform: "neutral", outfile: OUT, logLevel: "silent" });
const M = await import(pathToFileURL(OUT).href);
after(() => { fs.rmSync(OUT, { force: true }); fs.rmSync(ENTRY, { force: true }); });

const models = [
  M.specFor({ configId: "img", label: "Banana Pro", kind: "image", ui: { kind: "image", ratios: ["1:1"], sizes: ["2K"], batch: [1, 2, 4], secs: 12 } }),
  M.specFor({ configId: "txt", label: "Text", kind: "text" }),
];
function makeStore(nodes, edges = []) {
  const backend = { kind: "mock", available: () => true, loadDoc: async () => ({ doc: { nodes, edges, comments: [] }, version: 1 }), listModels: async () => models, saveDoc: async () => ({ ok: true, version: 2 }) };
  const store = new M.CanvasStore(backend, "c1");
  store.set({ doc: { nodes, edges, comments: [] }, models, loaded: true });
  return store;
}
const img = (id, x, extra = {}) => M.newNode("image", x, 0, { id, prompt: "海报", ...extra }, models[0]);

test("堆叠：收起成员、取消后回到画布；拖入、移出、少于 2 个自动解散", () => {
  const store = makeStore([img("a", 0), img("b", 300), img("c", 600)]);
  store.setUI({ sel: new Set(["a", "b"]) });
  const s = M.stackSelection(store);
  assert.ok(s && M.isStack(store.node(s.id)));
  assert.deepEqual([...M.hiddenIds(store.state.doc.nodes)].sort(), ["a", "b"]);
  assert.equal(M.addToStack(store, s.id, ["c"]), 1);
  assert.deepEqual(store.node(s.id).children, ["a", "b", "c"]);
  M.takeFromStack(store, s.id, "c");
  assert.deepEqual(store.node(s.id).children, ["a", "b"]);
  assert.ok(!M.hiddenIds(store.state.doc.nodes).has("c"));
  M.takeFromStack(store, s.id, "b");
  assert.equal(store.node(s.id), undefined, "只剩 1 个时堆叠解散");
  assert.equal(M.hiddenIds(store.state.doc.nodes).size, 0);
});

test("堆叠：少于 2 个不成叠；不能叠进分组 / 别的叠", () => {
  const store = makeStore([img("a", 0)]);
  store.setUI({ sel: new Set(["a"]) });
  assert.equal(M.stackSelection(store), null);
  const store2 = makeStore([img("a", 0), img("b", 300), img("c", 600)]);
  store2.setUI({ sel: new Set(["a", "b"]) }); const s = M.stackSelection(store2);
  store2.setUI({ sel: new Set(["b", "c"]) });
  assert.equal(M.stackSelection(store2), null, "b 已在叠里，只剩 c 一个");
  assert.equal(M.addToStack(store2, s.id, [s.id]), 0);
});

test("删除堆叠连同成员；复制粘贴堆叠时成员 id 一起换新", () => {
  const store = makeStore([img("a", 0), img("b", 300), img("c", 600)], [{ id: "e1", from: "a", to: "b" }]);
  store.setUI({ sel: new Set(["a", "b"]) }); const s = M.stackSelection(store);
  store.setUI({ sel: new Set([s.id]) });
  M.copySelection(store, true, false); M.paste(store);
  const stacks = store.state.doc.nodes.filter((n) => M.isStack(n));
  assert.equal(stacks.length, 2);
  const copy = stacks.find((n) => n.id !== s.id);
  assert.equal(copy.children.length, 2);
  assert.ok(copy.children.every((id) => store.node(id) && id !== "a" && id !== "b"));
  assert.equal(store.state.doc.edges.length, 2, "成员间连线也复制");
  store.setUI({ sel: new Set([s.id]) }); M.deleteSelection(store);
  assert.equal(store.node("a"), undefined); assert.equal(store.node("b"), undefined); assert.ok(store.node("c"));
});

test("分组运行计划：按依赖分层、统计调用次数、跳过上游没结果和手写节点", () => {
  const t = M.newNode("text", 0, 0, { id: "t", prompt: "写文案" }, models[1]);
  const manual = M.newNode("text", 0, 300, { id: "m", manual: true, hist: [{ text: "已有" }] }, models[1]);
  const a = img("a", 400, { params: { model: "img", ratio: "1:1", size: "2K", count: 4, search: false, style: "无", camera: { on: false, body: 0, lens: 0, focal: 2, aperture: 1 } } });
  const outside = M.newNode("text", -400, 600, { id: "o", prompt: "组外" }, models[1]);
  const b = img("b", 400, { prompt: "" });
  const store = makeStore([t, manual, a, outside, b], [{ id: "e1", from: "t", to: "a" }, { id: "e2", from: "m", to: "a" }, { id: "e3", from: "o", to: "b" }]);
  const plan = M.planGroup(store, ["t", "m", "a", "b"]);
  assert.deepEqual(plan.levels, [["t"], ["a"]]);
  assert.equal(plan.calls, 5, "文本 1 次 + 图片 4 张");
  assert.equal(plan.byKind.image, 4);
  assert.deepEqual(plan.skipped.map((x) => x.id), ["b"]);
  assert.match(plan.skipped[0].why, /组外|上游/);
});

test("zip：文件名去重、可被系统 unzip 解开且内容一致", async () => {
  assert.deepEqual(M.uniqueNames(["海报.png", "海报.png", "a/b.png"]), ["海报.png", "海报 (2).png", "a_b.png"]);
  const enc = new TextEncoder();
  const blob = await M.makeZip([{ name: "海报.txt", data: enc.encode("一") }, { name: "海报.txt", data: new Blob(["二"]) }]);
  const file = path.join(ROOT, "node_modules/.cache/oa-zip-" + process.pid + ".zip");
  fs.writeFileSync(file, Buffer.from(await blob.arrayBuffer()));
  try {
    const list = execFileSync("unzip", ["-Z1", file], { encoding: "utf8" }).trim().split("\n");
    assert.deepEqual(list, ["海报.txt", "海报 (2).txt"]);
    assert.equal(execFileSync("unzip", ["-p", file, "海报 (2).txt"], { encoding: "utf8" }), "二");
  } catch (err) { if (err.code !== "ENOENT") throw err; } finally { fs.rmSync(file, { force: true }); }
  assert.equal(M.crc32(enc.encode("123456789")), 0xcbf43926);
});
