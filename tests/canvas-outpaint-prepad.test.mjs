/**
 * 扩图二次加边修复（task-38）。
 *
 * 背景：扩图框已经按用户框的尺寸合成好「原图 + 透明扩展」的 PNG（例如 499×362），
 * 但 bridge 的 buildEdit 对 op='outpaint' 又无条件 padded()（×1.5）→ 实际请求 749×543，
 * 模型多出一大圈空白。修法：编辑框带 params.prepadded = true；bridge 只在没这个标记时才补边。
 *
 * 这里测决定「要不要再补边」的纯函数（真实现，esbuild 打临时 ESM 后 import），
 * 外加两条契约断言，防止有人把标记或分支改回去。
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
const bundle = path.join(os.tmpdir(), "oa-outpaint-prepad-" + process.pid + ".mjs");
await esbuild.build({
  entryPoints: [path.join(ROOT, "src/canvas/canvas-next/backend/bridge.ts")],
  bundle: true, format: "esm", platform: "neutral", outfile: bundle, logLevel: "silent",
});
const { needsOutpaintPadding } = await import(pathToFileURL(bundle).href);
test.after(() => { try { fs.rmSync(bundle, { force: true }); } catch { /* 忽略 */ } });

/** 扩图框尺寸 → padded() 会画出来的尺寸（padded: canvasOf(W*1.5*s, H*1.5*s)，s=min(1, 2048/(max*1.5))） */
function sizeIfPadded(width, height) {
  const s = Math.min(1, 2048 / (Math.max(width, height) * 1.5));
  return { w: Math.round(width * 1.5 * s), h: Math.round(height * 1.5 * s) };
}

test("prepadded=true：不再补边（请求尺寸 = 框上尺寸）", () => {
  assert.equal(needsOutpaintPadding({ prepadded: true }), false);
  assert.equal(needsOutpaintPadding({ ext: { n: 0.2, s: 0.3, e: 0.2, w: 0.3 }, prepadded: true }), false);
  // 真机那一组数字：框上 499×362，旧逻辑会变成 749×543
  assert.deepEqual(sizeIfPadded(499, 362), { w: 749, h: 543 }, "旧行为确实是 749×543");
  assert.equal(needsOutpaintPadding({ prepadded: true }), false, "带标记时请求应保持 499×362");
});

test("没传 / 明确 false / 非 true：保持老的加边行为", () => {
  assert.equal(needsOutpaintPadding(undefined), true);
  assert.equal(needsOutpaintPadding(null), true);
  assert.equal(needsOutpaintPadding({}), true);
  assert.equal(needsOutpaintPadding({ ext: {} }), true);
  assert.equal(needsOutpaintPadding({ prepadded: false }), true);
  assert.equal(needsOutpaintPadding({ prepadded: "true" }), true, "只认严格 true，宽松值不放行");
  assert.equal(needsOutpaintPadding({ prepadded: 1 }), true);
  assert.equal(needsOutpaintPadding([{ prepadded: true }]), true, "数组不当参数对象");
});

test("契约：编辑框带标记、bridge 按标记决定是否 padded", () => {
  const registry = fs.readFileSync(path.join(ROOT, "src/canvas/canvas-next/ui/editors/registry.tsx"), "utf8");
  const runEditLine = registry.split("\n").find((line) => line.includes('runEdit(ctl.store, n.id, "outpaint"')) || "";
  assert.match(runEditLine, /prepadded:\s*true/, "扩图框必须把 prepadded 交出去：" + runEditLine.trim().slice(0, 160));

  const bridge = fs.readFileSync(path.join(ROOT, "src/canvas/canvas-next/backend/bridge.ts"), "utf8");
  const branch = bridge.split("\n").find((line) => line.includes('case "outpaint"')) || "";
  assert.match(branch, /needsOutpaintPadding\(p\)/, "outpaint 分支要按标记决定：" + branch.trim().slice(0, 200));
  assert.equal(/case "outpaint":[^\n]*source: await padded\(source\)/.test(branch), false, "不能回到无条件 padded()");
});
