/**
 * 2026-10-30 对齐 TapNow 的几处交互：
 *   ① 剪辑：多选视频 / 音频「建剪辑」按画布阅读顺序放片段；拖进时间线追加；图片等不能放
 *   ② 评论：回复 / 编辑字段能存能读（200 字上限）；协作同步时改过的评论按「删掉再加回」发出
 *   ③ 源码：颜色标记栏、搜索 ↑↓ / Esc 先清空、全屏预览按钮、时间线 C / Q / E 与右键菜单都接上了
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const esbuild = require("esbuild");
const ROOT = path.resolve(import.meta.dirname, "..");
const CACHE = path.join(ROOT, "node_modules/.cache"); fs.mkdirSync(CACHE, { recursive: true });
const ENTRY = path.join(CACHE, "oa-gaps1030-entry-" + process.pid + ".ts");
const OUT = path.join(CACHE, "oa-gaps1030-" + process.pid + ".mjs");
const src = (p) => JSON.stringify(path.join(ROOT, "src/canvas", p));
fs.writeFileSync(ENTRY, [
  `export * from ${src("canvas-next/playlist.ts")};`,
  `export { CanvasStore } from ${src("canvas-next/store.ts")};`,
  `export { newNode, withGen } from ${src("canvas-next/model.ts")};`,
  `export { diffDoc } from ${src("canvas-next/collab.ts")};`,
  `export { sanitizeDoc } from ${src("react-canvas/reactCanvasStore.ts")};`,
].join("\n"));
const mem = new Map();
globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
await esbuild.build({ entryPoints: [ENTRY], bundle: true, format: "esm", platform: "neutral", outfile: OUT, logLevel: "silent" });
const T = await import(pathToFileURL(OUT).href);
after(() => { fs.rmSync(OUT, { force: true }); fs.rmSync(ENTRY, { force: true }); });
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

function makeStore() {
  const backend = {
    kind: "mock", available: () => true,
    loadDoc: async () => ({ doc: { nodes: [], edges: [], comments: [] }, version: 1, source: "mock" }),
    listModels: async () => [], onModelsChanged: () => () => {},
    saveDoc: async (_i, _d, v) => ({ ok: true, version: (v || 1) + 1 }),
    importAsset: async (_c, _d, name) => `openarc-asset:${name}`, resolveAsset: async (r) => r,
    generate: async () => ({ outputs: [] }),
  };
  const store = new T.CanvasStore(backend, "c1"); store.set({ loaded: true });
  return store;
}
const media = (kind, id, x, y, url, dur, trim) => T.withGen(T.newNode(kind, x, y, { id, title: id }), { hist: [{ url, dur, ...(trim ? { trim } : {}) }], hi: 0 });

test("① 建剪辑：按行再按列排；只收有结果的视频 / 音频；带上使用区间", () => {
  const store = makeStore();
  const nodes = [
    media("video", "b", 400, 10, "openarc-asset:b", 3),
    media("video", "a", 0, 0, "openarc-asset:a", 4, { in: 1, out: 3 }),
    media("video", "c", 0, 400, "openarc-asset:c", 5),
    media("audio", "m", 400, 420, "openarc-asset:m", 8),
    T.newNode("image", 800, 0, { id: "img", title: "img" }),
    T.newNode("video", 800, 400, { id: "empty", title: "empty" }),
  ];
  store.mutate((d) => ({ ...d, nodes }));
  const tl = T.createTimelineFrom(store, nodes);
  assert.ok(tl && tl.kind === "timeline");
  assert.ok(tl.x > 400 + nodes[0].w, "放在选区右边");
  const clips = store.node(tl.id).clips;
  assert.deepEqual(clips.filter((c) => c.mediaKind === "video").map((c) => c.sourceNodeId), ["a", "b", "c"]);
  assert.deepEqual(clips.filter((c) => c.mediaKind === "audio").map((c) => c.sourceNodeId), ["m"]);
  const a = clips.find((c) => c.sourceNodeId === "a"); assert.equal(a.inPoint, 1); assert.equal(a.outPoint, 3);
  assert.equal(T.clipable(store.node("img")), false); assert.equal(T.clipable(store.node("empty")), false);
  assert.equal(T.createTimelineFrom(store, [store.node("img")]), null);
});

test("① 拖进时间线：追加到末尾，顺序号连续；非时间线目标不处理", () => {
  const store = makeStore();
  const nodes = [media("video", "a", 0, 0, "openarc-asset:a", 4), media("video", "b", 0, 300, "openarc-asset:b", 2)];
  store.mutate((d) => ({ ...d, nodes }));
  const tl = T.createTimelineFrom(store, [nodes[0]]);
  assert.equal(T.addToTimeline(store, tl.id, ["b"]), 1);
  const clips = store.node(tl.id).clips;
  assert.deepEqual(clips.map((c) => [c.sourceNodeId, c.order]), [["a", 0], ["b", 1]]);
  assert.equal(T.addToTimeline(store, "a", ["b"]), 0);
});

test("② 评论回复 / 编辑：能存能读，超长截断，坏数据丢弃", () => {
  const doc = T.sanitizeDoc({ nodes: [], edges: [], comments: [{ id: "c1", x: 1, y: 2, text: "改大一点", createdAt: 5, clientId: "local", author: "L", editedAt: 9,
    replies: [{ id: "r1", text: "好", createdAt: 6, author: "M" }, { id: "", text: "坏" }, { id: "r2", text: "x".repeat(300), createdAt: 7 }] }] });
  const c = doc.comments[0];
  assert.equal(c.editedAt, 9);
  assert.deepEqual(c.replies.map((r) => r.id), ["r1", "r2"]);
  assert.equal(c.replies[1].text.length, 200);
  assert.equal(c.replies[0].author, "M");
  const plain = T.sanitizeDoc({ nodes: [], edges: [], comments: [{ id: "c2", text: "a", x: 0, y: 0 }] }).comments[0];
  assert.equal("replies" in plain, false);
});

test("② 协作：评论有新回复时发 remove + add（同一个 id）", () => {
  const c = { id: "c1", x: 0, y: 0, text: "a", createdAt: 1, clientId: "local" };
  const prev = { nodes: [], edges: [], comments: [c] };
  const next = { nodes: [], edges: [], comments: [{ ...c, replies: [{ id: "r", text: "b", createdAt: 2, clientId: "local" }] }] };
  const ops = T.diffDoc(prev, next, "me");
  assert.deepEqual(ops.map((o) => o.type), ["remove-comment", "add-comment"]);
  assert.equal(ops[1].comment.replies.length, 1);
  assert.deepEqual(T.diffDoc(prev, { ...prev, comments: [{ ...c }] }, "me"), []);
});

test("③ 界面接线", () => {
  const chrome = read("src/canvas/canvas-next/ui/Chrome.tsx");
  assert.match(chrome, /<PinBar \/>/); assert.match(chrome, /function PinBar\(\)/); assert.match(chrome, /data-pin=\{g\.k\}/);
  assert.match(chrome, /e\.key === "ArrowDown" \|\| e\.key === "ArrowUp"/); assert.match(chrome, /data-esc-clear/);
  assert.match(read("src/canvas/canvas-next/ui/overlay.tsx"), /"escClear" in t\.dataset && t\.value/);
  for (const k of ['data-lb="apply"', 'data-lb="locate"', 'data-lb="dl"', 'data-mb="playlist"', 'data-cmt="send"', 'data-cmt="edit"']) assert.ok(chrome.includes(k), "缺 " + k);
  assert.match(chrome, /e\.key === "Enter" && !e\.shiftKey && !e\.nativeEvent\.isComposing/);
  const tle = read("src/canvas/canvas-next/ui/TimelineEditor.tsx");
  assert.match(tle, /e\.key === "c" \|\| e\.key === "C"/); assert.match(tle, /trimTo\("l"\)/); assert.match(tle, /trimTo\("r"\)/);
  assert.match(tle, /data-clipmenu="locate"/); assert.match(tle, /data-tl="tocanvas"/);
  assert.match(read("src/canvas/canvas-next/ui/Viewport.tsx"), /addToTimeline\(store, tl,/);
});
