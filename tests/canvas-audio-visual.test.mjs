/**
 * 音频节点：真实波形峰值 + 实时频谱（低 / 中 / 高）。纯函数真跑 + 节点接线契约。
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
const out = path.join(ROOT, "node_modules/.cache/oa-audio-" + process.pid + ".mjs");
await esbuild.build({ entryPoints: [path.join(ROOT, "src/canvas/canvas-next/audioAnalysis.ts")], bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent" });
const A = await import(pathToFileURL(out).href);
test.after(() => fs.rmSync(out, { force: true }));

const SR = 44100;
/** 0~1s 80Hz 低音，1~2s 1kHz 中音，2~3s 6kHz 高音，3~4s 静音 */
function clip() {
  const s = new Float32Array(SR * 4);
  for (let i = 0; i < s.length; i++) {
    const t = i / SR; const f = t < 1 ? 80 : t < 2 ? 1000 : t < 3 ? 6000 : 0;
    s[i] = f ? 0.8 * Math.sin(2 * Math.PI * f * t) : 0;
  }
  return { samples: s, sampleRate: SR, duration: 4 };
}

test("spectrum：低音 / 中音 / 高音分别落在对应频段", () => {
  const d = clip();
  const lo = A.spectrum(d, 0.5, 48), mid = A.spectrum(d, 1.5, 48), hi = A.spectrum(d, 2.5, 48);
  assert.ok(lo.low > lo.mid && lo.low > lo.high, "80Hz 时低频最强 " + JSON.stringify(lo));
  assert.ok(mid.mid > mid.low && mid.mid > mid.high, "1kHz 时中频最强 " + JSON.stringify(mid));
  assert.ok(hi.high > hi.low && hi.high > hi.mid, "6kHz 时高频最强 " + JSON.stringify(hi));
  // 最高的那根条在左 / 中 / 右
  const argmax = (a) => a.indexOf(Math.max(...a));
  assert.ok(argmax(lo.bars) < argmax(mid.bars) && argmax(mid.bars) < argmax(hi.bars));
  assert.equal(lo.bars.length, 48);
});

test("spectrum：静音段全部接近 0，越界时间不报错", () => {
  const d = clip();
  const s = A.spectrum(d, 3.5, 32);
  assert.ok(Math.max(...s.bars) < 0.05, JSON.stringify(s.bars));
  assert.doesNotThrow(() => A.spectrum(d, -1, 16));
  assert.doesNotThrow(() => A.spectrum(d, 99, 16));
});

test("peaks：按最大值归一，静音段保留最小高度", () => {
  const d = clip();
  const p = A.peaks(d, 40);
  assert.equal(p.length, 40);
  assert.ok(Math.abs(Math.max(...p) - 1) < 1e-6);
  assert.ok(p.slice(31).every((v) => v === 0.04), "最后 1s 静音");
});

test("fakeSpectrum：演示数据也有起伏，条数正确", () => {
  const a = A.fakeSpectrum(0.3, 24), b = A.fakeSpectrum(0.9, 24);
  assert.equal(a.length, 24);
  assert.notDeepEqual(a, b);
});

test("节点接线：音频节点用 AudioBody，带频谱画布、播放指针和可拖动进度条", () => {
  const nv = fs.readFileSync(path.join(ROOT, "src/canvas/canvas-next/ui/NodeView.tsx"), "utf8");
  const ab = fs.readFileSync(path.join(ROOT, "src/canvas/canvas-next/ui/AudioBody.tsx"), "utf8");
  assert.match(nv, /import \{ AudioBody \} from "\.\/AudioBody"/);
  assert.match(nv, /<AudioBody out=\{out\} sel=\{p\.sel\} \/>/);
  for (const k of ["data-aviz", "data-atrack", "data-atrack-head", "data-atime", 'data-act="play"', "spectrum(", "peaks("]) assert.ok(ab.includes(k), k);
});

test("decodeAudio：桌面版 CSP 禁止 fetch，data URL 必须本地解 base64 而不是走 fetch", () => {
  const src = fs.readFileSync(path.join(ROOT, "src/canvas/canvas-next/audioAnalysis.ts"), "utf8");
  assert.match(src, /url\.startsWith\("data:"\)/);
  assert.match(src, /atob\(/);
});
