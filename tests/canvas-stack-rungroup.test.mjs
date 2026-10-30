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
  `export { planGroup, callsOf, runGroup, stopGroup } from ${JSON.stringify(path.join(ROOT, "src/canvas/canvas-next/engine.ts"))};`,
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

test("从普通分组拖进叠：同时移出原分组；删除叠时叠外下游也会刷新输入", () => {
  const g = { id: "g", kind: "group", x: 0, y: 0, w: 900, h: 300, children: ["a", "c"] };
  const store = makeStore([img("a", 0), img("b", 300), img("c", 600), img("d", 900), g], [{ id: "e1", from: "b", to: "d" }]);
  store.setUI({ sel: new Set(["b", "c"]) });
  // c 在分组 g 里：先把 b、d 叠起来，再把 c 拖进去
  store.setUI({ sel: new Set(["b", "d"]) }); const s = M.stackSelection(store);
  assert.equal(M.addToStack(store, s.id, ["c"]), 1);
  assert.deepEqual(store.node("g").children, ["a"], "c 离开原分组");
  assert.equal(M.groupLabel(store.node("g")), "分组"); assert.equal(M.groupLabel(store.node(s.id)), "堆叠");
  // 删除叠：成员 b、c、d 一起删，没有残留连线
  store.setUI({ sel: new Set([s.id]) }); M.deleteSelection(store);
  assert.equal(store.state.doc.edges.length, 0); assert.ok(store.node("a"));
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

test("一键运行：只跑没结果的节点时，已有结果的上游直接给下游用", () => {
  const t = M.newNode("text", 0, 0, { id: "t", prompt: "写文案", hist: [{ text: "旧文案" }] }, models[1]);
  const a = img("a", 400);
  const b = img("b", 800, { hist: [{ url: "data:image/png;base64,AA" }] });
  const store = makeStore([t, a, b], [{ id: "e1", from: "t", to: "a" }, { id: "e2", from: "a", to: "b" }]);
  const all = M.planGroup(store, ["t", "a", "b"]);
  assert.deepEqual(all.levels, [["t"], ["a"], ["b"]]); assert.equal(all.hasOut, 2);
  const miss = M.planGroup(store, ["t", "a", "b"], { onlyMissing: true });
  assert.deepEqual(miss.levels, [["a"]], "t、b 已有结果不跑；a 的上游 t 有结果，可以跑");
  assert.equal(miss.skipped.length, 0);
});

/** 假后端：每次生成等 ms 毫秒，支持中止 */
function runStore(nodes, edges, ms = 30) {
  const store = makeStore(nodes, edges); const calls = [];
  Object.assign(store.backend, {
    importAsset: async (_c, u) => u,
    generate: (req, _on, signal) => new Promise((res, rej) => {
      calls.push(req.nodeId);
      const t = setTimeout(() => res({ outputs: [req.kind === "text" ? { text: "结果" } : { url: "data:image/png;base64,AA", w: 1, h: 1 }] }), ms);
      signal?.addEventListener("abort", () => { clearTimeout(t); const e = new Error("stopped"); e.code = "STOPPED"; rej(e); });
    }),
  });
  return { store, calls };
}

test("一键运行：按层运行、登记进度，结束后清掉", async () => {
  const t = M.newNode("text", 0, 0, { id: "t", prompt: "写文案" }, models[1]);
  const { store, calls } = runStore([t, img("a", 400), img("b", 800)], [{ id: "e1", from: "t", to: "a" }, { id: "e2", from: "t", to: "b" }]);
  const plan = M.planGroup(store, ["t", "a", "b"]);
  const seen = [];
  const off = store.subscribe(() => { const b = store.state.batches.g1; if (b) seen.push(`${b.done}/${b.total}:${b.queued.length}`); });
  const r = await M.runGroup(store, plan, { key: "g1", label: "海报组" });
  off();
  assert.deepEqual(r, { ok: 3, failed: 0, skipped: 0, stopped: false });
  assert.equal(calls[0], "t", "上游先跑"); assert.deepEqual(calls.slice(1).sort(), ["a", "b"]);
  assert.ok(seen.includes("0/3:3") && seen.includes("1/3:2"), "进度：开始 0/3，跑完上游 1/3");
  assert.equal(store.state.batches.g1, undefined, "结束后进度清掉");
});

test("一键运行：中途停止，正在跑的中止、后面的不再开始", async () => {
  const t = M.newNode("text", 0, 0, { id: "t", prompt: "写文案" }, models[1]);
  const { store, calls } = runStore([t, img("a", 400)], [{ id: "e1", from: "t", to: "a" }], 200);
  const p = M.runGroup(store, M.planGroup(store, ["t", "a"]), { key: "g2" });
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(store.state.runtime.t, "t 正在跑");
  M.stopGroup(store, "g2");
  const r = await p;
  assert.equal(r.stopped, true); assert.equal(r.ok, 0);
  assert.deepEqual(calls, ["t"], "a 没有开始");
  assert.equal(store.state.batches.g2, undefined);
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
