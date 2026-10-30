/**
 * 音频节点（对齐 TapNow）：真实波形峰值 + 滚动波形 / 居中指针 / 时间气泡 / ±10 秒。纯函数真跑 + 节点接线契约。
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
const outs = [];
async function bundle(rel, name, opts = {}) {
  const out = path.join(ROOT, "node_modules/.cache/oa-audio-" + process.pid + "-" + name + ".mjs"); outs.push(out);
  await esbuild.build({ entryPoints: [path.join(ROOT, rel)], bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent", ...opts });
  return import(pathToFileURL(out).href);
}
const A = await bundle("src/canvas/canvas-next/audioAnalysis.ts", "an");
test.after(() => { for (const f of outs) fs.rmSync(f, { force: true }); });

const SR = 44100;
/** 0~2s 响，2~3s 静音，3~4s 小声 */
function clip() {
  const s = new Float32Array(SR * 4);
  for (let i = 0; i < s.length; i++) { const t = i / SR; const a = t < 2 ? 0.8 : t < 3 ? 0 : 0.2; s[i] = a * Math.sin(2 * Math.PI * 220 * t); }
  return { samples: s, sampleRate: SR, duration: 4 };
}

test("peaks：按最大值归一，静音段保留最小高度，小声段明显矮", () => {
  const p = A.peaks(clip(), 8); // 每根 0.5s
  assert.equal(p.length, 8);
  assert.ok(Math.abs(Math.max(...p) - 1) < 1e-6);
  assert.deepEqual(p.slice(4, 6), [0.04, 0.04], "2~3s 静音");
  assert.ok(p[6] > 0.2 && p[6] < 0.3, "小声段约 0.25：" + p[6]);
});

test("节点接线：音频节点用 AudioBody；波形画布、居中指针、时间气泡、±10 秒、播放按钮都在", () => {
  const nv = fs.readFileSync(path.join(ROOT, "src/canvas/canvas-next/ui/NodeView.tsx"), "utf8");
  const ab = fs.readFileSync(path.join(ROOT, "src/canvas/canvas-next/ui/AudioBody.tsx"), "utf8");
  assert.match(nv, /import \{ AudioBody \} from "\.\/AudioBody"/);
  assert.match(nv, /<AudioBody out=\{out\} sel=\{p\.sel\} \/>/);
  for (const k of ["data-aviz", "ahead-tri", "ahead-line", "data-atime", 'data-act="back10"', 'data-act="fwd10"', 'data-act="play"', "peaks(", "useMediaUrl("]) assert.ok(ab.includes(k), k);
  // 指针固定在正中，波形按当前时间整体左移
  assert.match(ab, /const x0 = w \/ 2 - \(time \/ SEC_PER_BAR\) \* pitch/);
});

test("clock2：两位分钟 00:08 / 02:38", async () => {
  const src = fs.readFileSync(path.join(ROOT, "src/canvas/canvas-next/ui/AudioBody.tsx"), "utf8");
  const fn = src.match(/export function clock2[\s\S]*?\n}\n/)[0].replace("export ", "").replace("(sec: number): string", "(sec)");
  const clock2 = new Function(fn + "; return clock2;")();
  assert.equal(clock2(8.9), "00:08");
  assert.equal(clock2(158), "02:38");
  assert.equal(clock2(-1), "00:00");
});

test("新建 / 上传的音频节点默认 320×180（时间气泡和按钮放得下）", () => {
  const model = fs.readFileSync(path.join(ROOT, "src/canvas/canvas-next/model.ts"), "utf8");
  const act = fs.readFileSync(path.join(ROOT, "src/canvas/canvas-next/actions.ts"), "utf8");
  assert.match(model, /audio: \{ w: 320, h: 180 \}/);
  assert.match(act, /: NODE_DEFAULT_SIZE\.audio\.h;/);
});

test("decodeAudio：桌面版 CSP 禁止 fetch，data URL 必须本地解 base64 而不是走 fetch", () => {
  const src = fs.readFileSync(path.join(ROOT, "src/canvas/canvas-next/audioAnalysis.ts"), "utf8");
  assert.match(src, /url\.startsWith\("data:"\)/);
  assert.match(src, /atob\(/);
});
