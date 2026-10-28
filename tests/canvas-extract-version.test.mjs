/**
 * 提取当前版本（task-66）：
 *   A) extractCurrentVersion 真实现：新节点只带当前版本、位置在右侧、标题「原标题 · 版本 n」，原节点不动；
 *   B) 契约：右键菜单有「提取当前版本」（hist>1 才可用）、轮播条「1/2」打开同两个动作、箭头保留。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const esbuild = require("esbuild");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = path.join(os.tmpdir(), "oa-extract-version-" + process.pid + ".mjs");
await esbuild.build({
  entryPoints: [path.join(ROOT, "src/canvas/canvas-next/actions.ts")],
  bundle: true, format: "esm", platform: "neutral", outfile: BUNDLE, logLevel: "silent",
});
const { extractCurrentVersion } = await import(pathToFileURL(BUNDLE).href);
test.after(() => { try { fs.rmSync(BUNDLE, { force: true }); } catch { /* 忽略 */ } });

/** 最小 store 桩：只用到 node / addNodes / toast */
function makeStore(node) {
  const store = {
    node: (id) => (id === node.id ? node : undefined),
    added: null, toastMsg: "",
    addNodes(nodes, edges, opts) { store.added = { nodes, edges, opts }; },
    toast(msg) { store.toastMsg = String(msg); },
  };
  return store;
}
const imageNode = () => ({
  id: "n_img", kind: "image", x: 100, y: 200, w: 220, h: 275,
  data: { gen: {
    title: "卖点海报", prompt: "生成一张海报", params: { model: "banana-pro", ratio: "3:4", count: 1 },
    hist: [{ url: "openarc-asset:o1", w: 640, h: 800 }, { url: "openarc-asset:o2", w: 640, h: 800 }], hi: 1, order: ["e_1"],
  } },
});
const videoNode = () => ({
  id: "n_vid", kind: "video", x: 40, y: 60, w: 320, h: 180,
  data: { gen: {
    title: "开箱短片", prompt: "镜头推进", params: { model: "seedance-2", mode: "首帧", ratio: "16:9", res: "720p", dur: 5, sound: true, times: 1 },
    hist: [{ url: "openarc-asset:v1", frame: "openarc-asset:f1", dur: 5, res: "720p" }, { url: "openarc-asset:v2", frame: "openarc-asset:f2", dur: 5, res: "720p" }], hi: 0, order: [],
  } },
});

test("A1 图片节点：新节点只带当前版本，位置右侧、y 对齐", () => {
  const node = imageNode(); const store = makeStore(node);
  const made = extractCurrentVersion(store, node.id);
  assert.ok(made, "应当返回新节点");
  assert.notEqual(made.id, node.id);
  assert.equal(made.x, node.x + node.w + 30, "x = 原节点 x + w + 30");
  assert.equal(made.y, node.y, "y 对齐");
  assert.equal(made.w, node.w); assert.equal(made.h, node.h);
  const g = made.data.gen;
  assert.equal(g.hist.length, 1);
  assert.deepEqual(g.hist[0], node.data.gen.hist[1], "带的必须是当前这一版的输出");
  assert.equal(g.hi, 0);
  assert.deepEqual(g.order, []);
  assert.equal(g.title, "卖点海报 · 版本 2");
  assert.equal(g.prompt, node.data.gen.prompt);
  assert.equal(g.params.model, "banana-pro");
  assert.equal(g.params.ratio, "3:4");
  assert.equal(g.params.count, 1);
  assert.equal(typeof g.params.style, "string", "参数经过同一套 clamp（与重新生成时口径一致）");
  assert.equal(made.kind, "image");
  assert.equal(store.added.nodes.length, 1);
  assert.equal(store.added.edges.length, 0);
  assert.equal(store.added.opts.select, true);
  assert.match(store.toastMsg, /已提取版本 2/);
});

test("A2 原节点不受影响（历史、当前版本、位置、标题都不变）", () => {
  const node = imageNode(); const before = JSON.parse(JSON.stringify(node)); const store = makeStore(node);
  extractCurrentVersion(store, node.id);
  assert.deepEqual(node, before, "原节点对象一个字段都不能变");
});

test("A3 视频节点同样可用（第一版：标题版本 1、带 frame/dur/res）", () => {
  const node = videoNode(); const store = makeStore(node);
  const made = extractCurrentVersion(store, node.id);
  assert.ok(made);
  const g = made.data.gen;
  assert.equal(made.kind, "video");
  assert.equal(g.title, "开箱短片 · 版本 1");
  assert.deepEqual(g.hist[0], node.data.gen.hist[0]);
  assert.equal(g.hist[0].frame, "openarc-asset:f1");
  assert.equal(g.hi, 0);
  assert.deepEqual(g.order, []);
  assert.equal(made.data.gen.params.mode, "首帧");
});

test("A4 边界：没有历史 / 节点不存在 → 返回 null 且不建节点", () => {
  const node = imageNode(); node.data.gen.hist = []; node.data.gen.hi = 0;
  const store = makeStore(node);
  assert.equal(extractCurrentVersion(store, node.id), null);
  assert.equal(store.added, null);
  const store2 = makeStore(node);
  assert.equal(extractCurrentVersion(store2, "nope"), null);
  assert.equal(store2.added, null);
});

/* ── B. 入口契约 ── */
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

test("B1 右键菜单：有「提取当前版本」，hist>1 才可用", () => {
  const src = read("src/canvas/canvas-next/ui/menus.tsx");
  const line = src.split("\n").find((l) => l.includes('data-k="extractver"')) || "";
  assert.match(line, /disabled={!g \|\| g\.hist\.length < 2}/, line.trim().slice(0, 160));
  assert.match(line, /extractCurrentVersion\(store, n\.id\)/);
  assert.match(line, /提取当前版本/);
});

test("B2 轮播条：1/2 文字变成可点按钮，左右箭头保留", () => {
  const src = read("src/canvas/canvas-next/ui/NodeView.tsx");
  const line = src.split("\n").find((l) => l.includes('className="vstrip')) || "";
  assert.match(line, /data-act="vprev"/);
  assert.match(line, /data-act="vmenu"/);
  assert.match(line, /data-act="vnext"/);
  assert.match(line, /\{g\.hi \+ 1\}\/\{g\.hist\.length\}/);
});

test("B3 1/2 菜单里同时有「提取当前版本 / 应用所有历史」", () => {
  const src = read("src/canvas/canvas-next/ui/menus.tsx");
  const block = src.slice(src.indexOf('if (act === "vmenu")'), src.indexOf('if (act === "vprev"'));
  assert.match(block, /extractCurrentVersion\(store, n\.id\)/);
  assert.match(block, /spreadHistory\(store, n\.id\)/);
  assert.match(block, /应用所有历史/);
  assert.match(block, /版本 \{g\.hi \+ 1\} \/ \{g\.hist\.length\}/);
});

test("B4 形状与 spreadHistory 一致（hist:[o], hi:0, order:[]）", () => {
  const src = read("src/canvas/canvas-next/actions.ts");
  const block = src.slice(src.indexOf("export function extractCurrentVersion"), src.indexOf("export function commitText"));
  assert.match(block, /x: n\.x \+ n\.w \+ 30/);
  assert.match(block, /y: n\.y/);
  assert.match(block, /title: g\.title \+ " · 版本 " \+ \(g\.hi \+ 1\)/);
  assert.match(block, /hist: \[o\], hi: 0, order: \[\]/);
});
