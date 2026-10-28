// 视频编辑工具（修剪 / 切镜 / AI 编辑 / 草稿模式）的前端逻辑
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const esbuild = require("esbuild");
const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "node_modules/.cache/oa-canvas-video-" + process.pid + ".mjs");
const ENTRY = path.join(ROOT, "node_modules/.cache/oa-canvas-video-entry-" + process.pid + ".ts");
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(ENTRY, [
  `export * from ${JSON.stringify(path.join(ROOT, "src/canvas/canvas-next/videoTools.ts"))};`,
  `export { buildRequest } from ${JSON.stringify(path.join(ROOT, "src/canvas/canvas-next/engine.ts"))};`,
  `export { CanvasStore } from ${JSON.stringify(path.join(ROOT, "src/canvas/canvas-next/store.ts"))};`,
  `export { newNode, specFor, resRange, draftRes, genOf } from ${JSON.stringify(path.join(ROOT, "src/canvas/canvas-next/model.ts"))};`,
].join("\n"));
await esbuild.build({ entryPoints: [ENTRY], bundle: true, format: "esm", platform: "neutral", outfile: OUT, logLevel: "silent" });
const M = await import(pathToFileURL(OUT).href);
after(() => { fs.rmSync(OUT, { force: true }); fs.rmSync(ENTRY, { force: true }); });

const seed = M.specFor({ configId: "sd", label: "Seedance 2.0", kind: "video" });
const veo = M.specFor({ configId: "veo", label: "Veo 3.1", kind: "video" });
const hailuo = M.specFor({ configId: "hl", label: "Hailuo 02", kind: "video" });
function makeStore(nodes, backendExtra = {}) {
  const backend = { kind: "mock", available: () => true, saveDoc: async () => ({ ok: true, version: 2 }), resolveAsset: async () => null, importAsset: async (_c, d) => d, ...backendExtra };
  const store = new M.CanvasStore(backend, "c1");
  store.set({ doc: { nodes, edges: [], comments: [] }, models: [hailuo, veo, seed], loaded: true });
  return store;
}
const video = (id, extra = {}) => M.newNode("video", 0, 0, { id, title: "片子", hist: [{ url: "data:video/mp4;base64,AAAA", dur: 9, ...extra }], params: { model: "hl", mode: "文生视频", ratio: "16:9", res: "720p", dur: 5, sound: false, times: 1 } }, hailuo);

test("草稿模式：取模型最低清晰度发请求，关掉后恢复原清晰度", () => {
  assert.deepEqual(M.resRange(seed), { low: "480p", high: "1080p" });
  assert.equal(M.resRange(M.specFor({ configId: "x", label: "x", kind: "video", ui: { kind: "video", res: ["720p"] } })), null);
  const n = M.newNode("video", 0, 0, { id: "v", prompt: "海边", params: { model: "sd", mode: "文生视频", ratio: "16:9", res: "1080p", dur: 5, sound: false, times: 1, draft: true } }, seed);
  const store = makeStore([n]);
  assert.equal(M.buildRequest(store, store.node("v")).params.res, "480p");
  store.patchGen("v", (g) => ({ params: { ...g.params, draft: false } }));
  assert.equal(M.buildRequest(store, store.node("v")).params.res, "1080p");
});

test("AI 编辑选模型：当前模型不支持时换成支持该方式的模型；提示词按操作生成", () => {
  const store = makeStore([video("v")]);
  assert.equal(M.modelFor(store, "视频编辑", hailuo).id, "sd");
  assert.equal(M.modelFor(store, "视频延长", veo).id, "veo");
  assert.match(M.aiPrompt("replace", "杯子", "玫瑰"), /「杯子」替换成「玫瑰」/);
  assert.match(M.aiPrompt("remove", "路人"), /移除「路人」/);
  assert.match(M.aiPrompt("retake", "俯拍"), /俯拍/);
});

test("修剪没有设区间时不动；有区间但后端不能裁剪时退回区间引用节点并连线", async () => {
  const store = makeStore([video("v")]);
  assert.equal(await M.trimToNode(store, store.node("v")), null);
  store.patchGen("v", (g) => ({ hist: g.hist.map((h) => ({ ...h, trim: { in: 2, out: 5 } })) }));
  const made = await M.trimToNode(store, store.node("v"));
  assert.ok(made);
  assert.deepEqual(M.genOf(made).hist[0].trim, { in: 2, out: 5 });
  assert.equal(store.state.doc.edges.filter((e) => e.from === "v" && e.to === made.id).length, 1);
});

test("修剪：后端能裁剪时用裁出来的资源引用和真实时长", async () => {
  const calls = [];
  const store = makeStore([video("v", { trim: { in: 1, out: 4 } })], { clipVideo: async (c, d, segs, name) => { calls.push({ c, segs, name }); return { ok: true, clips: [{ ref: "openarc-asset:cut", duration: 3, inSec: 1, outSec: 4 }] }; } });
  const made = await M.trimToNode(store, store.node("v"));
  assert.deepEqual(calls[0].segs, [{ inSec: 1, outSec: 4 }]);
  const h = M.genOf(made).hist[0];
  assert.equal(h.url, "openarc-asset:cut"); assert.equal(h.dur, 3); assert.equal(h.trim, undefined);
});

test("智能切镜：按检测结果拆成多个节点；只有一个镜头时不拆", async () => {
  let shots = [{ inSec: 0, outSec: 3 }, { inSec: 3, outSec: 9 }];
  const store = makeStore([video("v")], { detectScenes: async () => ({ ok: true, duration: 9, shots }) });
  const made = await M.smartClip(store, store.node("v"));
  assert.equal(made.length, 2);
  shots = [{ inSec: 0, outSec: 9 }];
  assert.equal((await M.smartClip(store, store.node("v"))).length, 0);
});

test("重拍一段：裁不出真文件时不退回整段（避免重拍并计费整段）；裁出来后连到新节点；新片段不沿用源封面", async () => {
  const trimmed = () => video("v", { trim: { in: 2, out: 4 }, frame: "data:image/png;base64,F" });
  const noClip = makeStore([trimmed()]);
  assert.equal(await M.aiVideoEdit(noClip, noClip.node("v"), "retake", "俯拍"), null);
  assert.equal(noClip.state.doc.nodes.length, 1, "没有留下半成品节点");
  const clipped = makeStore([trimmed()], { clipVideo: async (_c, _d, segs) => ({ ok: true, clips: segs.map((s, i) => ({ ref: "openarc-asset:clip" + i, duration: s.outSec - s.inSec })) }) });
  const out = await M.aiVideoEdit(clipped, clipped.node("v"), "retake", "俯拍");
  assert.ok(out);
  const clip = clipped.state.doc.nodes.find((n) => M.genOf(n).hist[0]?.url === "openarc-asset:clip0");
  assert.ok(clip, "裁出的片段节点"); assert.equal(M.genOf(clip).hist[0].frame, undefined);
  assert.ok(clipped.state.doc.edges.some((e) => e.from === clip.id && e.to === out.id), "新节点以片段为源视频");
});
