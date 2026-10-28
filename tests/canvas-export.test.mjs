/**
 * 整画布导出（exportCanvas.ts）纯逻辑回归。
 *
 * 导出的几何/绘画函数不碰 DOM：这里用「记录器 ctx」直接断言绘制指令，
 * 用 esbuild 把 TS 源打成一个临时 ESM 再 import（跑真实现，不是复制品）。
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
const bundle = path.join(os.tmpdir(), "oa-canvas-export-" + process.pid + ".mjs");
await esbuild.build({
  entryPoints: [path.join(ROOT, "src/canvas/canvas-next/exportCanvas.ts")],
  bundle: true, format: "esm", platform: "neutral", outfile: bundle, logLevel: "silent",
});
const {
  pickExportNodes, computeExportBounds, exportPixels, exportFileName, drawCanvasExport,
  readCanvasPalette, DARK_PALETTE, LIGHT_PALETTE, EXPORT_PADDING, GRID_STEP,
} = await import(pathToFileURL(bundle).href);
test.after(() => { try { fs.rmSync(bundle, { force: true }); } catch { /* 忽略 */ } });

/* ---------- 夹具 ---------- */

const imageNode = (over = {}) => ({
  id: "img1", kind: "image", x: 0, y: 0, w: 240, h: 240, text: "图片", url: "openarc-asset:res1",
  data: { gen: { title: "商品图", hist: [{ url: "openarc-asset:res1" }], hi: 0, params: {} } }, ...over,
});
const textNode = (over = {}) => ({
  id: "txt1", kind: "text", x: 320, y: 40, w: 280, h: 200, text: "",
  data: { gen: { title: "文案", hist: [{ text: "一只猫坐在窗台上，阳光从左边照进来。这是一段比较长的文本，用来验证导出的换行。" }], hi: 0, params: {} } }, ...over,
});
const tableNode = (over = {}) => ({
  id: "tbl1", kind: "table", x: 0, y: 320, w: 420, h: 220, text: "表",
  data: { gen: { title: "多维表格", hist: [], hi: 0, params: {} }, table: { kind: "table", version: 1, title: "多维表格", columns: ["产品", "卖点"], rows: [["水壶", "轻"], ["杯子", "耐热"]] } }, ...over,
});
const videoNode = (over = {}) => ({
  id: "vid1", kind: "video", x: 700, y: 0, w: 320, h: 180, text: "视频",
  data: { gen: { title: "短片", hist: [{ url: "openarc-asset:res2", frame: "openarc-asset:res3" }], hi: 0, params: {} } }, ...over,
});

/** 记录器 ctx：断言绘制指令，不需要真 canvas */
function recorder() {
  const ops = [];
  const ctx = {
    fillStyle: "", strokeStyle: "", lineWidth: 1, font: "", textBaseline: "alphabetic", textAlign: "left", globalAlpha: 1,
    save: () => ops.push(["save"]),
    restore: () => ops.push(["restore"]),
    setTransform: (...a) => ops.push(["setTransform", ...a]),
    translate: (...a) => ops.push(["translate", ...a]),
    scale: (...a) => ops.push(["scale", ...a]),
    beginPath: () => ops.push(["beginPath"]),
    closePath: () => ops.push(["closePath"]),
    moveTo: (...a) => ops.push(["moveTo", ...a]),
    lineTo: (...a) => ops.push(["lineTo", ...a]),
    quadraticCurveTo: (...a) => ops.push(["quadraticCurveTo", ...a]),
    bezierCurveTo: (...a) => ops.push(["bezierCurveTo", ...a]),
    rect: (...a) => ops.push(["rect", ...a]),
    clip: () => ops.push(["clip"]),
    arc: (...a) => ops.push(["arc", ...a]),
    fill: () => ops.push(["fill", ctx.fillStyle]),
    stroke: () => ops.push(["stroke", ctx.strokeStyle, ctx.lineWidth]),
    fillRect: (...a) => ops.push(["fillRect", ctx.fillStyle, ...a]),
    strokeRect: (...a) => ops.push(["strokeRect", ...a]),
    fillText: (t, x, y) => ops.push(["fillText", String(t), x, y]),
    measureText: (t) => ({ width: String(t).length * 7 }),
    drawImage: (...a) => ops.push(["drawImage", a.length]),
  };
  const count = (name) => ops.filter((o) => o[0] === name).length;
  const texts = () => ops.filter((o) => o[0] === "fillText").map((o) => o[1]);
  return { ctx, ops, count, texts };
}

/* ---------- ① 范围 ---------- */

test("pickExportNodes：全部 / 选中 / 选中为空回落全部", () => {
  const doc = { nodes: [imageNode(), textNode(), tableNode()] };
  const all = pickExportNodes(doc, { range: "all" });
  assert.equal(all.nodes.length, 3);
  assert.equal(all.range, "all");

  const some = pickExportNodes(doc, { range: "selection", selectedIds: ["img1", "tbl1"] });
  assert.deepEqual(some.nodes.map((n) => n.id), ["img1", "tbl1"]);
  assert.equal(some.range, "selection");

  const fallback = pickExportNodes(doc, { range: "selection", selectedIds: [] });
  assert.equal(fallback.nodes.length, 3, "没选中时不能导出一张空图");
  assert.equal(fallback.range, "all");

  const unknown = pickExportNodes(doc, { range: "selection", selectedIds: ["nope"] });
  assert.equal(unknown.range, "all");
  assert.equal(pickExportNodes({ nodes: [] }, {}).nodes.length, 0);
});

/* ---------- ② 包围盒 / 像素 / 文件名 ---------- */

test("computeExportBounds：含标题 24px、默认内边距 40、负坐标也对", () => {
  const b = computeExportBounds([imageNode(), textNode()]);
  // image (0,0,240,240) → 右 240 / 底 264；text (320,40,280,200) → 右 600 / 底 264
  assert.deepEqual(b, { x: -40, y: -40, w: 600 + 80, h: 264 + 80 });
  assert.equal(computeExportBounds([imageNode()], 0).w, 240);
  assert.equal(computeExportBounds([imageNode()], 0).h, 264, "卡片上方的 24px 标题要算进去");
  // 负坐标：包围盒跟着走，尺寸只由节点本身决定（240 宽 + 标题 24 + 高 240，各加两侧 10 内边距）
  assert.deepEqual(computeExportBounds([imageNode({ x: -500, y: -300 })], 10), { x: -510, y: -310, w: 260, h: 284 });
  assert.equal(computeExportBounds([]), null);
  assert.equal(computeExportBounds(null), null);
  assert.equal(EXPORT_PADDING, 40);
});

test("exportPixels：1x / 2x 与像素上限收敛", () => {
  const b = { x: 0, y: 0, w: 600, h: 400 };
  assert.deepEqual(exportPixels(b, 1), { width: 600, height: 400, scale: 1 });
  assert.deepEqual(exportPixels(b, 2), { width: 1200, height: 800, scale: 2 });
  assert.equal(exportPixels(b, 2.5).width, 1500);
  // 长边上限
  const clamped = exportPixels({ x: 0, y: 0, w: 10000, h: 5000 }, 2, 8192);
  assert.ok(clamped.width <= 8192 && clamped.height <= 8192, JSON.stringify(clamped));
  assert.ok(clamped.scale < 2, "超上限必须收敛倍率");
  // 总像素上限
  const tiny = exportPixels({ x: 0, y: 0, w: 4000, h: 4000 }, 2, 8192, 8_000_000);
  assert.ok(tiny.width * tiny.height <= 8_100_000, JSON.stringify(tiny));
  // 非法倍率不炸
  assert.equal(exportPixels(b, 0).width, 600);
  assert.equal(exportPixels(b, NaN).width, 600);
});

test("exportFileName：去非法字符 / 范围 / 倍率 / 扩展名", () => {
  assert.equal(exportFileName("未命名画布"), "未命名画布.png");
  assert.equal(exportFileName("a/b:c*?"), "a_b_c__.png");
  assert.equal(exportFileName("画布", { range: "selection" }), "画布-选中.png");
  assert.equal(exportFileName("画布", { scale: 2 }), "画布-2x.png");
  assert.equal(exportFileName("画布", { format: "jpeg" }), "画布.jpg");
  assert.equal(exportFileName("画布", { format: "jpeg", scale: 2, range: "selection" }), "画布-选中-2x.jpg");
  assert.equal(exportFileName(""), "画布.png");
  assert.equal(exportFileName(null), "画布.png");
  assert.equal(exportFileName("x".repeat(200)).length <= 84, true);
  assert.equal(exportFileName("画布", { scale: 1.5 }), "画布-1.5x.png");
});

/* ---------- ③ 绘制 ---------- */

test("drawCanvasExport：背景铺满 + 点阵（可关）+ 倍率写进 setTransform", () => {
  const nodes = [imageNode()];
  const bounds = computeExportBounds(nodes);
  const r = recorder();
  const res = drawCanvasExport(r.ctx, { nodes, bounds, scale: 2, palette: DARK_PALETTE });
  assert.deepEqual(res, { nodes: 1, edges: 0 });
  const t = r.ops.find((o) => o[0] === "setTransform");
  assert.deepEqual(t, ["setTransform", 2, 0, 0, 2, (-bounds.x) * 2, (-bounds.y) * 2], "世界坐标要按倍率缩放并平移到画布原点");
  const bg = r.ops.find((o) => o[0] === "fillRect");
  assert.deepEqual(bg.slice(2, 6), [bounds.x, bounds.y, bounds.w, bounds.h], "背景铺满整个包围盒");
  assert.equal(bg[1], DARK_PALETTE.background, "背景底色用调色板 background");
  const gridDots = r.count("fillRect") - 1;
  assert.ok(gridDots > 0, "默认带点阵背景");
  const noGrid = recorder();
  drawCanvasExport(noGrid.ctx, { nodes, bounds, scale: 1, includeGrid: false });
  assert.equal(noGrid.count("fillRect"), 1, "关掉点阵只剩背景");
  assert.equal(GRID_STEP, 20);
});

test("drawCanvasExport：连线一条贝塞尔 + 端点在导出集合外的连线丢弃", () => {
  const nodes = [imageNode(), textNode()];
  const edges = [{ from: "img1", to: "txt1" }, { from: "img1", to: "ghost" }];
  const r = recorder();
  const res = drawCanvasExport(r.ctx, { nodes, edges, bounds: computeExportBounds(nodes), scale: 1 });
  assert.equal(res.edges, 1, "缺端点的连线不画");
  assert.equal(r.count("bezierCurveTo"), 1);
  assert.equal(r.count("stroke") >= 1, true);
  const off = recorder();
  drawCanvasExport(off.ctx, { nodes, edges, bounds: computeExportBounds(nodes), scale: 1, includeEdges: false });
  assert.equal(off.count("bezierCurveTo"), 0);
});

test("drawCanvasExport：每个节点都有标题 + 卡片，图片 cover 进圆角，视频多一个播放键", () => {
  const nodes = [imageNode(), textNode(), tableNode(), videoNode()];
  const bounds = computeExportBounds(nodes);
  const images = new Map([
    ["img1", { source: { tag: "img1" }, width: 1000, height: 500 }],
    ["vid1", { source: { tag: "vid1" }, width: 320, height: 180 }],
  ]);
  const r = recorder();
  const res = drawCanvasExport(r.ctx, { nodes, bounds, scale: 1, images });
  assert.equal(res.nodes, 4);
  // 生成类节点用 gen.title；表格不是生成类节点，标题用节点自己的 text
  assert.deepEqual(r.texts().filter((t) => ["商品图", "文案", "表", "短片"].includes(t)), ["商品图", "文案", "表", "短片"]);
  assert.equal(r.count("drawImage"), 2, "图片节点与视频首帧都要画图");
  assert.equal(r.count("clip"), 2, "图片按圆角裁切");
  assert.ok(r.count("arc") >= 1, "视频要有播放圆");
  assert.equal(r.count("fill") >= 4, true, "每张卡片至少一次填充");
});

test("drawCanvasExport：文本节点按宽度换行，超出的行加省略号", () => {
  const long = "这是一段很长的文本".repeat(20);
  const nodes = [textNode({ data: { gen: { title: "长文", hist: [{ text: long }], hi: 0, params: {} } }, w: 200, h: 120 })];
  const r = recorder();
  drawCanvasExport(r.ctx, { nodes, bounds: computeExportBounds(nodes), scale: 1 });
  const lines = r.ops.filter((o) => o[0] === "fillText" && o[1] !== "长文").map((o) => o[1]);
  assert.ok(lines.length >= 3, "长文本要多行");
  assert.equal(lines[lines.length - 1].endsWith("…") || lines.join("").length < long.length, true, "放不下时如实省略");
  for (const line of lines) assert.ok(String(line).length * 7 <= 200 - 24 + 7, "每行不超过卡片宽度");
});

test("drawCanvasExport：表格画表头，未知节点画居中说明，不抛异常", () => {
  const r = recorder();
  drawCanvasExport(r.ctx, { nodes: [tableNode()], bounds: computeExportBounds([tableNode()]), scale: 1 });
  assert.deepEqual(r.texts().filter((t) => t === "产品" || t === "卖点"), ["产品", "卖点"]);
  const other = recorder();
  assert.doesNotThrow(() => drawCanvasExport(other.ctx, { nodes: [{ id: "a", kind: "audio", x: 0, y: 0, w: 200, h: 100, text: "" }], bounds: computeExportBounds([{ id: "a", kind: "audio", x: 0, y: 0, w: 200, h: 100 }]), scale: 1 }));
  assert.ok(other.texts().some((t) => t === "音频"));
});

test("readCanvasPalette：没有 DOM 时回退深色，浅色调色板可直接注入", () => {
  assert.deepEqual(readCanvasPalette(null), DARK_PALETTE);
  const r = recorder();
  const nodes = [imageNode()];
  drawCanvasExport(r.ctx, { nodes, bounds: computeExportBounds(nodes), scale: 1, palette: LIGHT_PALETTE });
  const bg = r.ops.find((o) => o[0] === "fillRect");
  assert.equal(bg[1], LIGHT_PALETTE.background);
});
