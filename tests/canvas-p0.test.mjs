/**
 * task-69 P0：视频使用区间 / 选中徽标 / 右键分组 / 多选工具条 / 小地图自动。
 * 纯函数真跑（model 的 trim、minimap 阈值、actions 的对齐）+ 入口契约。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const esbuild = require("esbuild");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = (name) => path.join(ROOT, "node_modules/.cache/oa-p0-" + process.pid + "-" + name + ".mjs");
const bundles = [];
async function bundle(rel, name) {
  const out = tmp(name); bundles.push(out);
  await esbuild.build({ entryPoints: [path.join(ROOT, rel)], bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent" });
  return import(pathToFileURL(out).href);
}
test.after(() => { for (const f of bundles) { try { fs.rmSync(f, { force: true }); } catch { /* 忽略 */ } } });

const model = await bundle("src/canvas/canvas-next/model.ts", "model");
const mini = await bundle("src/canvas/canvas-next/ui/minimap.ts", "mini");
const actions = await bundle("src/canvas/canvas-next/actions.ts", "actions");

/* ── ① 使用区间 ── */
test("T1 clampTrim：默认整段、夹到 [0,dur]、in<out 至少 0.2s、按 0.01s 取整", () => {
  assert.deepEqual(model.clampTrim(10, undefined), { in: 0, out: 10 });
  assert.deepEqual(model.clampTrim(10, { in: 2.2, out: 8.6 }), { in: 2.2, out: 8.6 });
  assert.deepEqual(model.clampTrim(10, { in: -3, out: 99 }), { in: 0, out: 10 });
  assert.deepEqual(model.clampTrim(10, { in: 9.95, out: 9.99 }), { in: 9.8, out: 10 });
  assert.deepEqual(model.clampTrim(10, { in: 8, out: 3 }), { in: 8, out: 8.2 });
  assert.deepEqual(model.clampTrim(undefined, { in: 1, out: 4 }), { in: 1, out: 4 });
  assert.deepEqual(model.clampTrim(10, { in: 1.234, out: 5.678 }), { in: 1.23, out: 5.68 });
});

test("T2 trimIsFull / trimLabel", () => {
  assert.equal(model.trimIsFull(10, undefined), true);
  assert.equal(model.trimIsFull(10, { in: 0, out: 10 }), true);
  assert.equal(model.trimIsFull(10, { in: 0.02, out: 9.99 }), true);
  assert.equal(model.trimIsFull(10, { in: 2.2, out: 8.6 }), false);
  assert.equal(model.trimIsFull(undefined, { in: 0, out: 10 }), true);
  assert.equal(model.trimLabel({ in: 2.2, out: 8.6 }), "2.2s – 8.6s");
  assert.equal(model.trimLabel(undefined), "");
});

/* ── ⑤ 小地图自动 ── */
test("M1 minimapVisible：自动按缩放，手动偏好优先", () => {
  assert.equal(mini.minimapVisible(null, 0.2), true);
  assert.equal(mini.minimapVisible(null, mini.MINIMAP_ZOOM), false);
  assert.equal(mini.minimapVisible(undefined, 1), false);
  assert.equal(mini.minimapVisible(false, 0.1), false, "手动关掉就不要再自动冒出来");
  assert.equal(mini.minimapVisible(true, 1.4), true, "手动打开就一直显示");
  assert.equal(mini.MINIMAP_ZOOM, 0.35);
});

/* ── ④ 对齐（多选工具条的动作） ── */
function fakeStore(nodes) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return {
    state: { ui: { sel: new Set(nodes.map((n) => n.id)) } },
    node: (id) => byId.get(id),
    updateNode(id, fn) { byId.set(id, fn(byId.get(id))); },
    toast() {},
    byId,
  };
}
const mk = (id, x, y, w = 100) => ({ id, x, y, w, h: 100, kind: "image" });

test("A1 alignSelection：左对齐 / 顶对齐 / 水平等距（只改位置）", () => {
  const s1 = fakeStore([mk("a", 0, 40), mk("b", 50, 0), mk("c", 200, 90)]);
  actions.alignSelection(s1, "left");
  assert.deepEqual([s1.byId.get("a").x, s1.byId.get("b").x, s1.byId.get("c").x], [0, 0, 0]);
  assert.deepEqual([s1.byId.get("a").y, s1.byId.get("b").y, s1.byId.get("c").y], [40, 0, 90], "y 不动");

  const s2 = fakeStore([mk("a", 0, 40), mk("b", 50, 0), mk("c", 200, 90)]);
  actions.alignSelection(s2, "top");
  assert.deepEqual([s2.byId.get("a").y, s2.byId.get("b").y, s2.byId.get("c").y], [0, 0, 0]);

  const s3 = fakeStore([mk("a", 0, 0, 100), mk("b", 20, 0, 100), mk("c", 300, 0, 100)]);
  actions.alignSelection(s3, "hgap");
  const xs = ["a", "b", "c"].map((id) => s3.byId.get(id).x);
  assert.equal(xs[0], 0, "最左不动");
  assert.equal(xs[2], 300, "最右不动");
  assert.equal(xs[1], 150, "中间放在两端等距的位置（间距 = (400-300)/2 = 50，第二块 x = 100+50）");
  assert.equal(s3.byId.get("a").w, 100, "尺寸不变");
});

test("A2 alignSelection：不足 2 个节点时不动", () => {
  const s = fakeStore([mk("a", 10, 10)]);
  actions.alignSelection(s, "left");
  assert.equal(s.byId.get("a").x, 10);
});

/* ── 契约：入口都接上了 ── */
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

test("C1 选中徽标：NodeView 渲染模型 + 第 n/m 版，Viewport 传模型名", () => {
  const nv = read("src/canvas/canvas-next/ui/NodeView.tsx");
  assert.match(nv, /className="nbadges"/);
  assert.match(nv, /data-badge="model"/);
  assert.match(nv, /data-badge="version">第 \{g\.hi \+ 1\}\/\{g\.hist\.length\} 版/);
  assert.match(nv, /p\.sel && out/);
  assert.match(read("src/canvas/canvas-next/ui/Viewport.tsx"), /modelName=\{\(store\.modelOf\(n\) \|\| \{\}\)\.name\}/);
});

test("C2 使用区间：条上有 in/out 手柄，播放循环在区间内，截帧/下载按区间", () => {
  const nv = read("src/canvas/canvas-next/ui/NodeView.tsx");
  assert.match(nv, /data-trim-handle="in"/);
  assert.match(nv, /data-trim-handle="out"/);
  assert.match(nv, /data-trim-total/);
  assert.match(nv, /el\.currentTime >= trim\.out - 0\.02 \|\| el\.currentTime < trim\.in - 0\.12/);
  assert.match(nv, /onPlay=\{\(e\) => \{ if \(trim && e\.currentTarget\.currentTime < trim\.in - 0\.05\)/);
  const reg = read("src/canvas/canvas-next/ui/editors/registry.tsx");
  assert.match(reg, /const trim = o\.trim \? clampTrim\(o\.dur, o\.trim\) : null;/);
  assert.match(reg, /trim \? trim\.in : Math\.min\(0\.05/);
  const menus = read("src/canvas/canvas-next/ui/menus.tsx");
  // task-72：区间下载先走主进程 ffmpeg（media/clipVideo），失败/没 ffmpeg 才退回完整下载并说明
  assert.match(menus, /media\/clipVideo/);
  assert.match(menus, /FFMPEG_MISSING/);
  assert.match(menus, /已导出 /);
  assert.match(menus, /已下载完整视频/);
  assert.match(menus, /trimIsFull\(o\.dur, trim\)/);
});

test("C3 空白右键：上传/添加资产/添加节点/添加辅助工具 ┃ 撤销/重做 ┃ 粘贴", () => {
  const src = read("src/canvas/canvas-next/ui/menus.tsx");
  const block = src.slice(src.indexOf("export function blankMenu"), src.indexOf("export function onNodeAct"));
  const order = ["上传", "添加资产", "添加节点", "添加辅助工具", "撤销", "重做", "粘贴"];
  let last = -1;
  for (const label of order) { const at = block.indexOf(label); assert.ok(at > last, label + " 的顺序不对"); last = at; }
  assert.match(block, /createLegacy\(ctl, k, w\)/);
  const seps = (block.match(/className="msep"/g) || []).length;
  assert.ok(seps >= 2, "至少两条分隔线，实际 " + seps);
});

test("C4 节点右键按用途分组（资产 ┃ 版本 ┃ 运行 ┃ 编辑 ┃ 删除）", () => {
  const src = read("src/canvas/canvas-next/ui/menus.tsx");
  const block = src.slice(src.indexOf("export function nodeMenu"), src.indexOf("export function blankMenu"));
  assert.ok((block.match(/className="msep"/g) || []).length >= 5, "至少 5 条分隔线");
  const idx = (label) => block.indexOf(label);
  assert.ok(idx("存入资产库") < idx("提取当前版本"));
  assert.ok(idx("提取当前版本") < idx("运行到此"));
  assert.ok(idx("运行到此") < idx("复制"));
  assert.ok(idx('data-k="copy"') < idx('data-k="del"'));
});

test("C5 多选工具条：已选 N 个 / 对齐 / 批量运行 / 下载 / 删除；多选时不显示 composer", () => {
  const src = read("src/canvas/canvas-next/ui/Chrome.tsx");
  const block = src.slice(src.indexOf("function MultiBar"), src.indexOf("function Minimap"));
  for (const label of ["已选", "对齐", "批量运行", "下载", "删除"]) assert.ok(block.includes(label), "缺 " + label);
  assert.match(block, /data-mb="align"/);
  assert.match(block, /alignSelection\(store, "left"\)/);
  assert.match(src, /\{ui\.sel\.size > 1 \? <MultiBar \/> : null\}/);
  const gen = read("src/canvas/canvas-next/ui/GenPanel.tsx");
  assert.match(gen, /const id = ui\.sel\.size === 1 && !ui\.dragging && !editing \? \[\.\.\.ui\.sel\]\[0\] : null;/);
});

test("C6 小地图：默认跟随缩放，点一次就切换可见并保留手动偏好", () => {
  const src = read("src/canvas/canvas-next/ui/Chrome.tsx");
  assert.match(src, /minimapVisible\(ui\.mini, view\.k\)/);
  assert.match(src, /data-mini-pref=\{ui\.mini === null \? "auto"/);
  // 按钮按「当前是否可见」取反：一次点击一定有可见变化
  assert.match(src, /store\.setUI\(\{ mini: !showMini \}\)/);
  assert.match(read("src/canvas/canvas-next/store.ts"), /mini: boolean \| null;/);
  assert.match(read("src/canvas/canvas-next/store.ts"), /agentFull: false, mini: null,/);
});
