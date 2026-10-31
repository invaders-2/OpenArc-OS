// 提示词 @ 引用上游（对齐 TapNow）：记号解析、连线自动补引用、只发送被 @ 的上游、发给模型的文字
import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const esbuild = require("esbuild");
const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "node_modules/.cache/oa-mentions-" + process.pid + ".mjs");
const vals = new Map();
globalThis.localStorage = { getItem: (k) => vals.get(k) ?? null, setItem: (k, v) => vals.set(k, String(v)), removeItem: (k) => vals.delete(k) };
const entry = path.join(ROOT, "node_modules/.cache/oa-mentions-entry-" + process.pid + ".ts");
const src = (f) => JSON.stringify(path.join(ROOT, "src/canvas/canvas-next", f));
fs.writeFileSync(entry, `export * from ${src("mentions.ts")};\nexport { CanvasStore } from ${src("store.ts")};\nexport { connect, addMention } from ${src("actions.ts")};\nexport { buildRequest, resolvePrompt } from ${src("engine.ts")};\n`);
await esbuild.build({ entryPoints: [entry], bundle: true, format: "esm", platform: "neutral", outfile: OUT, logLevel: "silent", loader: { ".css": "empty" } });
const M = await import(pathToFileURL(OUT).href);
after(() => { fs.rmSync(OUT, { force: true }); fs.rmSync(entry, { force: true }); });

const imageModel = { id: "i1", name: "Banana Pro", vendor: "g", tags: [], kind: "image", secs: 10, ratios: ["1:1", "3:4"], sizes: ["2K"], i2i: true, maxRefs: 4, specSource: "spec" };
const gen = (title, extra = {}) => ({ gen: { title, prompt: "", params: { model: "i1", ratio: "3:4", size: "2K", count: 1, style: "无", camera: { on: false } }, hist: [], hi: 0, order: [], ...extra } });
async function canvas(nodes, edges = []) {
  const backend = { kind: "mock", available: () => true, loadDoc: async () => ({ doc: { nodes: [], edges: [], comments: [] }, version: 1, source: "mock" }), listModels: async () => [imageModel], onModelsChanged: () => () => {}, saveDoc: async (_i, _d, v) => ({ ok: true, version: (v || 1) + 1 }) };
  const store = new M.CanvasStore(backend, "c-men"); await store.load();
  store.set({ models: [imageModel] });
  store.mutate((d) => ({ ...d, nodes, edges }));
  return store;
}
const img = (id, title, url) => ({ id, kind: "image", x: 0, y: 0, w: 200, h: 200, data: gen(title, { hist: [{ url }], uploaded: true }) });

test("记号：解析 / 显示成 @标题 / 改写后的 @标题 换回记号", () => {
  const p = "把 @{a} 的毛色换成 @{b} 的，参考 @{t#海报2}";
  assert.deepEqual(M.parseMentions(p).map((m) => [m.id, m.section]), [["a", undefined], ["b", undefined], ["t", "海报2"]]);
  const nodes = [img("a", "小狗A", "u1"), img("b", "小狗B", "u2"), { id: "t", kind: "text", x: 0, y: 0, w: 1, h: 1, data: { gen: { title: "卖点", prompt: "", params: {}, hist: [{ text: "海报1\n甲\n海报2\n乙" }], hi: 0, order: [] } } }];
  const plain = M.plainPrompt(p, { nodes });
  assert.equal(plain, "把 @小狗A 的毛色换成 @小狗B 的，参考 @卖点·海报2");
  assert.equal(M.relinkMentions(plain, nodes), p);
  assert.equal(M.appendMention("hi", "a"), "hi @{a} ");
  assert.equal(M.appendMention("hi @{a} ", "a"), "hi @{a} ", "不重复");
});

test("连线自动在下游提示词里补引用，第一次切到引用模式时把已有输入一起补上", async () => {
  const store = await canvas([img("a", "图A", "u1"), img("b", "图B", "u2"), { id: "o", kind: "image", x: 400, y: 0, w: 200, h: 200, data: gen("输出", { prompt: "做一张海报" }) }], [{ id: "e0", from: "a", to: "o" }]);
  assert.equal(store.node("o").data.gen.refMode, undefined, "旧节点不在引用模式");
  M.connect(store, "b", "o", { quiet: true });
  const g = store.node("o").data.gen;
  assert.equal(g.refMode, "mention");
  assert.deepEqual(M.parseMentions(g.prompt).map((m) => m.id), ["a", "b"], "旧输入 a 先补上，新连的 b 在后");
  assert.ok(g.prompt.startsWith("做一张海报"));
});

test("只发送被 @ 的上游；发给模型的提示词里换成「图N」", async () => {
  const store = await canvas([img("a", "图A", "u1"), img("b", "图B", "u2"), { id: "o", kind: "image", x: 400, y: 0, w: 200, h: 200, data: gen("输出", { prompt: "把 @{b} 的毛色改成 ...", refMode: "mention", order: ["e1", "e2"] }) }], [{ id: "e1", from: "a", to: "o" }, { id: "e2", from: "b", to: "o" }]);
  const req = M.buildRequest(store, store.node("o"));
  assert.deepEqual(req.inputs.map((x) => x.nodeId), ["b"], "a 没被 @，不发送");
  assert.match(req.resolvedPrompt, /^把 「图1」 的毛色/);
  // 不在引用模式：全部发送，记号仍按发送顺序编号
  store.patchGen("o", { refMode: undefined, prompt: "@{a} 和 @{b}" });
  const req2 = M.buildRequest(store, store.node("o"));
  assert.deepEqual(req2.inputs.map((x) => x.nodeId), ["a", "b"]);
  assert.equal(req2.resolvedPrompt, "「图1」 和 「图2」");
});

test("文本节点引用：换成原文 / 分段，不再重复作为上下文", async () => {
  const t = { id: "t", kind: "text", x: 0, y: 0, w: 1, h: 1, data: { gen: { title: "卖点", prompt: "", params: {}, hist: [{ text: "海报1\n一戴就静\n海报2\n轻到忘记" }], hi: 0, order: [], manual: true } } };
  const store = await canvas([t, { id: "o", kind: "image", x: 400, y: 0, w: 200, h: 200, data: gen("输出", { prompt: "主标题用 @{t#海报2}", refMode: "mention" }) }], [{ id: "e1", from: "t", to: "o" }]);
  const out = M.resolvePrompt(store.state.doc, store.node("o"));
  assert.equal(out, "主标题用 「轻到忘记」");
});

test("断开连线后的引用退回成标题，不发送", async () => {
  const store = await canvas([img("a", "图A", "u1"), { id: "o", kind: "image", x: 400, y: 0, w: 200, h: 200, data: gen("输出", { prompt: "参考 @{a}", refMode: "mention" }) }], []);
  const req = M.buildRequest(store, store.node("o"));
  assert.equal(req.inputs.length, 0);
  assert.equal(req.resolvedPrompt, "参考 「图A」");
});
