import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const esbuild = require("esbuild");
const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "node_modules/.cache/oa-snap-guides-" + process.pid + ".mjs");
await esbuild.build({ entryPoints: [path.join(ROOT, "src/canvas/canvas-next/snapGuides.ts")], bundle: true, format: "esm", platform: "neutral", outfile: OUT, logLevel: "silent" });
const { snapToGuides, unionBox, bodyBox, HEAD_H } = await import(pathToFileURL(OUT).href);
fs.rmSync(OUT, { force: true });

const other = { x: 100, y: 100, w: 200, h: 100 };

test("左边差 4 以内吸到对方左边，并画一条竖线贯穿两者", () => {
  const r = snapToGuides({ x: 103, y: 400, w: 120, h: 80 }, [other], 6);
  assert.equal(r.dx, -3); assert.equal(r.dy, 0);
  const g = r.guides.find((x) => x.axis === "x" && x.at === 100);
  assert.ok(g); assert.equal(g.from, 100); assert.equal(g.to, 480);
});

test("中线对齐：横竖两个方向分别吸附", () => {
  // 对方中心 (200,150)；拖动框中心 (202,148)
  const r = snapToGuides({ x: 152, y: 128, w: 100, h: 40 }, [other], 6);
  assert.equal(r.dx, -2); assert.equal(r.dy, 2);
  assert.ok(r.guides.some((g) => g.axis === "x" && g.at === 200));
  assert.ok(r.guides.some((g) => g.axis === "y" && g.at === 150));
});

test("取最近的一条：右边贴左边比左边贴左边更近", () => {
  // 拖动框右边 98 → 对方左边 100（差 2）；左边 -2 离谁都远
  const r = snapToGuides({ x: -2, y: 500, w: 100, h: 50 }, [other], 6);
  assert.equal(r.dx, 2);
});

test("超出阈值不吸附、不画线", () => {
  const r = snapToGuides({ x: 120, y: 400, w: 50, h: 50 }, [other], 6);
  assert.equal(r.dx, 0); assert.equal(r.dy, 0); assert.equal(r.guides.length, 0);
});

test("同一条线对上多个节点时合成一条，从最上到最下", () => {
  const a = { x: 0, y: 0, w: 50, h: 50 }, b = { x: 0, y: 300, w: 80, h: 50 };
  const r = snapToGuides({ x: 2, y: 150, w: 60, h: 60 }, [a, b], 6);
  const lines = r.guides.filter((g) => g.axis === "x" && g.at === 0);
  assert.equal(lines.length, 1); assert.equal(lines[0].from, 0); assert.equal(lines[0].to, 350);
});

test("多选拖动按整体外框对齐；节点框扣掉标题行", () => {
  const u = unionBox([{ x: 10, y: 10, w: 20, h: 20 }, { x: 50, y: 0, w: 10, h: 100 }]);
  assert.deepEqual(u, { x: 10, y: 0, w: 50, h: 100 });
  assert.deepEqual(bodyBox({ x: 1, y: 2, w: 3, h: 4 }), { x: 1, y: 2 + HEAD_H, w: 3, h: 4 });
  assert.equal(unionBox([]), null);
});
