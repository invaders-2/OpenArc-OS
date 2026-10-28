/**
 * task-76：未配置模型时，参数弹层仍展示可调档位（灰显不可点），顶部有引导 + 打开模型设置；
 * 有模型时行为不变（仍走模型 uiSpec / 可点）。
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
const OUT = path.join(ROOT, "node_modules/.cache/oa-nomodel-" + process.pid + ".mjs");
fs.mkdirSync(path.dirname(OUT), { recursive: true });
await esbuild.build({ entryPoints: [path.join(ROOT, "src/canvas/canvas-next/model.ts")], bundle: true, format: "esm", platform: "neutral", outfile: OUT, logLevel: "silent" });
const model = await import(pathToFileURL(OUT).href);
test.after(() => { try { fs.rmSync(OUT, { force: true }); } catch { /* 忽略 */ } });

test("P1 placeholderSpec：图片/文本/视频都有可展示的档位", () => {
  const img = model.placeholderSpec("image");
  assert.equal(img.kind, "image");
  assert.ok(img.ratios.includes("1:1") && img.ratios.length >= 5);
  assert.deepEqual(img.sizes, ["1K", "2K", "4K"]);
  assert.deepEqual(img.batch, [1, 2, 4]);
  assert.equal(img.style, true); assert.equal(img.camera, true); assert.equal(img.search, true);
  const text = model.placeholderSpec("text");
  assert.equal(text.kind, "text");
  assert.equal(text.search, true);
  const video = model.placeholderSpec("video");
  assert.ok(video.modes.includes("首帧") && video.res.includes("720p") && video.durs.includes(5));
  assert.ok(model.PLACEHOLDER_SPECS.audio.kinds.includes("音乐"));
});

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const src = () => read("src/canvas/canvas-next/ui/GenPanel.tsx");

test("P2 paramPop：没模型不再直接 return，改用占位规格 + disabled", () => {
  const s = src();
  assert.equal(/const \{ m \} = cur\(\); if \(!m\) return;/.test(s), false, "不能静默 return");
  assert.match(s, /const mm = m \|\| placeholderSpec\(kind\)/);
  assert.match(s, /const dis = !m;/);
  assert.match(s, /data-nomodel/);
  assert.match(s, /data-k="open-models"/);
  assert.match(s, /还没有可用的\{TYPE_LABEL\[kind\]\}模型：下面是可调档位（灰显）/);
  assert.match(s, /disabled=\{dis\}/);
});

test("P3 比例/次数/输出仍走禁用弹层；风格/摄影机改成受能力门控的自管浮层", () => {
  const s = src();
  for (const seg of ["ratio", "count"]) assert.ok(s.includes('if (k === "' + seg + '") return pop('), seg + " 段没走 pop()");
  assert.ok(s.includes('if (k === "output") return pop('));
  assert.match(s, /function RatioPop\(\{ node, model, disabled = false \}/);
  assert.match(s, /function DurPop\(\{ node, m, disabled = false \}/);
  assert.match(s, /function VRatioPop\(\{ node, m, disabled = false \}/);
  // 风格 / 摄影机：各自的自管浮层（不经过全局 popover 栈，才能按 SPEC 走完整 150ms 动效）
  assert.match(s, /function CamLayer\(/);
  assert.match(s, /function StyleLayer\(/);
  assert.equal(/function CameraPop\(/.test(s), false, "旧的开关+分段+滑块浮层已移除");
});

test("P4 单行里的风格/摄影机按模型能力渲染（没模型 / 不支持就不给入口，不置灰）", () => {
  const s = src();
  assert.match(s, /if \(m\?\.style\) gline\.push/);
  assert.match(s, /if \(m\?\.camera\) gline\.push/);
  assert.equal(/if \(!m \|\| m\.style\)/.test(s), false, "不能再对没模型的节点渲染风格入口");
  assert.match(s, /data-chip="style"/);
  assert.match(s, /data-chip="camera"/);
  const css = read("src/canvas/canvas-next/ui/canvas-next.css");
  assert.match(css, /\.gp-chip\.cam\{width:110px;\}/);
  assert.match(css, /\.gp-chip\.cam\.on\{width:120px/);
  assert.match(css, /\.gp-chip\.style\{width:68px;\}/);
  assert.match(css, /\.gp-nomodel\{/);
});

test("P5 有模型时行为不变：真实模型优先，控件不禁用", () => {
  const s = src();
  assert.match(s, /const m = model \|\| store\.modelOf\(node\)!/, "传了 model 用传的，否则仍读节点模型");
  // disabled 只在 dis 为真时传 true（有模型时 dis=false）
  assert.equal(/disabled=\{true\}/.test(s.slice(s.indexOf("if (k === \"ratio\")"), s.indexOf("function useNodeParams"))), false);
});
