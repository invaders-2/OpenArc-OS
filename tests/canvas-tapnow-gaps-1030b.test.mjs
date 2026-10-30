/**
 * 2026-10-30 对齐 TapNow 第 6～10 条：
 *   ① 分组框：建组时框里压着的节点一起编进来；拖进框加入、拖出框移出；框只扩不缩；堆叠不受影响
 *   ② 分段重拍：切点 / 合并；全部保留原样不发请求；续写可以往前补开头
 *   ③ 源码接线：⌘I、V、音频工具条、图片提示词 / 快捷指令
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
const ENTRY = path.join(CACHE, "oa-gaps1030b-entry-" + process.pid + ".ts");
const OUT = path.join(CACHE, "oa-gaps1030b-" + process.pid + ".mjs");
const src = (p) => JSON.stringify(path.join(ROOT, "src/canvas/canvas-next", p));
fs.writeFileSync(ENTRY, [`export * from ${src("groupFit.ts")};`, `export { splitSeg, mergeSeg, aiPrompt, retakeSegments, KEEP } from ${src("videoTools.ts")};`].join("\n"));
const mem = new Map();
globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
await esbuild.build({ entryPoints: [ENTRY], bundle: true, format: "esm", platform: "neutral", outfile: OUT, logLevel: "silent" });
const T = await import(pathToFileURL(OUT).href);
after(() => { fs.rmSync(OUT, { force: true }); fs.rmSync(ENTRY, { force: true }); });
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const N = (id, x, y, w = 200, h = 150, kind = "image") => ({ id, kind, x, y, w, h, text: id });

test("① 建组：框里压着、没选中的节点也编进来；别的组 / 堆叠里的不算", () => {
  const a = N("a", 0, 0), b = N("b", 260, 40), c = N("c", 520, 0), far = N("far", 2000, 0), inStack = N("s1", 300, 60);
  const stack = { id: "st", kind: "group", x: 280, y: 40, w: 240, h: 200, text: "堆叠", children: ["s1"], data: { stack: true } };
  const doc = { nodes: [a, b, c, far, inStack, stack], edges: [], comments: [] };
  const box = T.frameOf([a, c]);
  assert.deepEqual(T.strayInFrame(doc, ["a", "c"], box), ["b"]);
});

test("① 拖进框加入、拖出框移出；框扩大包住组员但不缩小", () => {
  const a = N("a", 0, 0), b = N("b", 260, 0), out = N("o", 900, 0);
  const g = { id: "g", kind: "group", x: -28, y: -38, w: 516, h: 240, text: "分组", children: ["a", "b"] };
  // o 拖进框
  let doc = { nodes: [a, b, { ...out, x: 120, y: 20 }, g], edges: [], comments: [] };
  let next = T.reconcileGroups(doc, ["o"]);
  assert.deepEqual(next.nodes.find((n) => n.id === "g").children, ["a", "b", "o"]);
  // b 拖到很远：移出，框不缩
  doc = { nodes: [a, { ...b, x: 3000 }, g], edges: [], comments: [] };
  next = T.reconcileGroups(doc, ["b"]);
  const g2 = next.nodes.find((n) => n.id === "g");
  assert.deepEqual(g2.children, ["a"]); assert.equal(g2.w, g.w);
  // a 往右挪一点（中心还在框里）：留在组里，框扩大
  doc = { nodes: [{ ...a, x: 300 }, b, g], edges: [], comments: [] };
  next = T.reconcileGroups(doc, ["a"]);
  const g3 = next.nodes.find((n) => n.id === "g");
  assert.deepEqual(g3.children, ["a", "b"]); assert.ok(g3.x + g3.w >= 300 + 200 + 28);
  // 拖整个分组：不改成员
  const same = { nodes: [a, b, g], edges: [], comments: [] };
  assert.equal(T.reconcileGroups(same, ["g", "a", "b"]), same);
  // 堆叠成员不受影响
  const st = { id: "st", kind: "group", x: 0, y: 0, w: 10, h: 10, text: "堆叠", children: ["a"], data: { stack: true } };
  const d2 = { nodes: [a, st, g], edges: [], comments: [] };
  assert.deepEqual(T.reconcileGroups(d2, ["a"]).nodes.find((n) => n.id === "g").children, ["a", "b"]);
});

test("② 分段：切点两边至少 1 秒；合并；全保留原样不发请求", async () => {
  const segs = [{ in: 0, out: 10, cam: "推近特写" }];
  const two = T.splitSeg(segs, 4); assert.deepEqual(two.map((s) => [s.in, s.out]), [[0, 4], [4, 10]]);
  assert.equal(T.splitSeg(two, 4.5), null); assert.equal(T.splitSeg(two, 0.5), null);
  const three = T.splitSeg(two, 7); assert.equal(three.length, 3);
  assert.deepEqual(T.mergeSeg(three, 1).map((s) => [s.in, s.out]), [[0, 4], [4, 10]]);
  const toasts = []; const store = { toast: (t) => toasts.push(t) };
  assert.equal(await T.retakeSegments(store, { id: "v" }, [{ in: 0, out: 3, cam: T.KEEP }, { in: 3, out: 5, cam: T.KEEP }]), null);
  assert.match(toasts[0], /没有要重拍/);
});

test("② 续写往前补开头的提示词", () => {
  assert.match(T.aiPrompt("extend", "空镜头", "before"), /第一帧之前.*衔接到原视频的第一帧/);
  assert.match(T.aiPrompt("extend", "", "after"), /最后一帧/);
});

test("③ 界面接线", () => {
  const app = read("src/canvas/canvas-next/CanvasApp.tsx");
  assert.match(app, /mod && k === "i"/); assert.match(app, /openPointEdit\(one\.id\)/); assert.match(app, /!mod && k === "v" && !e\.repeat/);
  assert.match(read("src/canvas/tapnow/AgentPanel.tsx"), /if \(activeMic\) \{ try \{ activeMic\.stop\(\)/);
  const gp = read("src/canvas/canvas-next/ui/GenPanel.tsx");
  assert.match(gp, /node\.kind === "audio" && out\) items = \[tagBtn\(\)/);
  assert.match(gp, /slashMenu\(e\.target\)/); assert.match(gp, /id: "angles9", name: "多角度九宫格"/);
  const vt = read("src/canvas/canvas-next/ui/VideoTools.tsx");
  assert.match(vt, /data-vai-dir/); assert.match(vt, /data-rt="cut"/); assert.match(vt, /retakeSegments\(store, node/);
  assert.match(read("src/canvas/canvas-next/ui/Viewport.tsx"), /reconcileGroups\(store\.state\.doc/);
  assert.match(read("src/canvas/canvas-next/ui/LegacyNodes.tsx"), /strayInFrame\(store\.state\.doc, ids, box0\)/);
});
