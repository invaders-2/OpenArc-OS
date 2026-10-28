import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const esbuild = require("esbuild");
const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "node_modules/.cache/oa-prompt-opt-" + process.pid + ".mjs");
const vals = new Map();
globalThis.localStorage = { getItem: (k) => vals.get(k) ?? null, setItem: (k, v) => vals.set(k, String(v)), removeItem: (k) => vals.delete(k) };
const entry = path.join(ROOT, "node_modules/.cache/oa-prompt-opt-entry-" + process.pid + ".ts");
fs.writeFileSync(entry, `export * from ${JSON.stringify(path.join(ROOT, "src/canvas/canvas-next/promptOptimize.ts"))};\nexport { CanvasStore } from ${JSON.stringify(path.join(ROOT, "src/canvas/canvas-next/store.ts"))};\n`);
await esbuild.build({ entryPoints: [entry], bundle: true, format: "esm", platform: "neutral", outfile: OUT, logLevel: "silent", loader: { ".css": "empty" } });
const M = await import(pathToFileURL(OUT).href);
after(() => { fs.rmSync(OUT, { force: true }); fs.rmSync(entry, { force: true }); });

const textModel = { id: "t1", name: "Plain Text", vendor: "x", tags: [], kind: "text", secs: 5 };
const visionModel = { id: "t2", name: "Vision Text", vendor: "x", tags: [], kind: "text", secs: 5, vision: true };
const imageModel = { id: "i1", name: "Banana Pro", vendor: "g", tags: [], kind: "image", secs: 10, ratios: ["1:1", "3:4"], sizes: ["2K"], i2i: true, maxRefs: 4, style: true, specSource: "spec" };

async function canvas() {
  const backend = {
    kind: "mock", available: () => true,
    loadDoc: async () => ({ doc: { nodes: [], edges: [], comments: [] }, version: 1, source: "mock" }),
    listModels: async () => [textModel, visionModel, imageModel], onModelsChanged: () => () => {},
    saveDoc: async (_i, _d, v) => ({ ok: true, version: (v || 1) + 1 }),
  };
  const store = new M.CanvasStore(backend, "c-opt"); await store.load();
  store.set({ models: [textModel, visionModel, imageModel] });
  return store;
}

test("收集上下文：上游文字 + 上游图片 + 节点自己的图 + 所选模型参数", async () => {
  const store = await canvas();
  store.mutate((d) => ({ ...d,
    nodes: [
      { id: "txt", kind: "text", x: 0, y: 0, w: 200, h: 100, data: { gen: { title: "卖点", prompt: "", params: { model: "t1", search: false }, hist: [{ text: "降噪 45dB，续航 30 小时" }], hi: 0, order: [] } } },
      { id: "ref", kind: "image", x: 0, y: 200, w: 200, h: 200, data: { gen: { title: "产品图", prompt: "", params: {}, hist: [{ url: "openarc-asset:ref" }], hi: 0, order: [] } } },
      { id: "out", kind: "image", x: 400, y: 0, w: 200, h: 200, data: { gen: { title: "海报", prompt: "做一张海报 @卖点", params: { model: "i1", ratio: "3:4", size: "2K", count: 1, style: "电影感", camera: { on: false } }, hist: [{ url: "openarc-asset:mine" }], hi: 0, order: ["e1", "e2"] } } },
    ],
    edges: [{ id: "e1", from: "txt", to: "out" }, { id: "e2", from: "ref", to: "out" }] }));
  const ctx = M.optimizeContext(store, store.node("out"));
  assert.equal(ctx.kind, "image"); assert.equal(ctx.model?.id, "i1");
  assert.equal(ctx.own?.image, "openarc-asset:mine");
  assert.equal(ctx.upstream.length, 2);
  assert.ok(ctx.upstream.some((s) => s.text?.includes("30 小时")));
  assert.ok(ctx.upstream.some((s) => s.image === "openarc-asset:ref"));

  const tm = M.pickOptimizerModel(store.state.models, ctx, true, null);
  assert.equal(tm.id, "t2", "有图时选能看图的文本模型");
  const { messages, images } = M.buildOptimizeMessages(ctx, true);
  assert.deepEqual(images, ["openarc-asset:mine", "openarc-asset:ref"]);
  const sys = messages[0].content, user = messages[1].content;
  assert.ok(sys.includes(M.OPTIMIZE_MARK));
  assert.ok(sys.includes("Banana Pro"), "写明目标模型");
  assert.ok(sys.includes("3:4") && sys.includes("电影感"), "带上比例和已选风格");
  assert.ok(sys.includes("@标题·段落"), "要求保留引用");
  assert.ok(user.includes("做一张海报 @卖点"));
  assert.ok(user.includes("降噪 45dB"));
  await store.dispose();
});

test("对话模型看不了图：不附图，只告诉它有图", async () => {
  const ctx = { kind: "video", model: undefined, params: { mode: "图生视频", dur: 5, ratio: "16:9" }, prompt: "", upstream: [{ title: "首帧", kind: "image", role: "首帧", image: "openarc-asset:a" }] };
  const { messages, images } = M.buildOptimizeMessages(ctx, false);
  assert.equal(images.length, 0);
  assert.ok(messages[1].content.includes("未附上"));
  assert.ok(messages[1].content.includes("请根据上面的输入写一条"));
  assert.ok(messages[0].content.includes("5 秒"));
});

test("选模型：文本节点用自己的模型；记住的偏好优先；没有文本模型返回空", () => {
  assert.equal(M.pickOptimizerModel([textModel, visionModel], { kind: "text", model: textModel }, false, null).id, "t1");
  assert.equal(M.pickOptimizerModel([textModel, visionModel], { kind: "image", model: imageModel }, false, "t2").id, "t2");
  assert.equal(M.pickOptimizerModel([textModel], { kind: "image", model: imageModel }, true, null).id, "t1", "没有能看图的也给一个文本模型");
  assert.equal(M.pickOptimizerModel([imageModel], { kind: "image", model: imageModel }, false, null), undefined);
});

test("清理模型输出：代码块、前缀、引号", () => {
  assert.equal(M.cleanOptimized("```\n一只猫\n```"), "一只猫");
  assert.equal(M.cleanOptimized("优化后的提示词：一只猫"), "一只猫");
  assert.equal(M.cleanOptimized("「一只猫」"), "一只猫");
  assert.equal(M.cleanOptimized("  Prompt: a cat  "), "a cat");
  assert.equal(M.cleanOptimized(""), "");
});

test("什么都没有时不发请求", () => {
  assert.equal(M.canOptimize({ kind: "image", params: {}, prompt: "  ", upstream: [] }), false);
  assert.equal(M.canOptimize({ kind: "image", params: {}, prompt: "猫", upstream: [] }), true);
});
