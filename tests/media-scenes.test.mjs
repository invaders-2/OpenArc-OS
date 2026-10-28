/**
 * 10-28：视频智能切镜（media/detectScenes）与修剪进画布（media/clipToCanvas）。
 * 没有 ffmpeg 的机器上只跑纯函数与命令登记部分。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { detectScenes, clipToCanvas, parseCuts, shotsOf } = require("../electron/media-scenes.cjs");
const { findFfmpeg, findFfprobe } = require("../electron/media-clip.cjs");
const canvasBootstrap = require("../electron/canvas-bootstrap.cjs");

const FFMPEG = findFfmpeg();
const HAS_FFMPEG = !!(FFMPEG && findFfprobe(null, FFMPEG));
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "oa-scenes-test-"));
const FIXTURE = path.join(ROOT, "three-shots.mp4");
// 三个纯色镜头：黑 2s → 白 2s → 黑 2s，切点应在 2s、4s 左右
const ready = HAS_FFMPEG && spawnSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y",
  "-f", "lavfi", "-i", "color=c=black:s=160x120:r=25:d=2", "-f", "lavfi", "-i", "color=c=white:s=160x120:r=25:d=2", "-f", "lavfi", "-i", "color=c=black:s=160x120:r=25:d=2",
  "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0", "-c:v", "libx264", "-pix_fmt", "yuv420p", FIXTURE]).status === 0;
const dataUrl = () => "data:video/mp4;base64," + fs.readFileSync(FIXTURE).toString("base64");
test.after(() => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ } });

test("切点解析：排序、按最小间隔合并、去掉贴着首尾的切点", () => {
  const stderr = "x pts_time:4.04 y\nx pts_time:2.0 y\nx pts_time:2.3 y\nx pts_time:0.1 y\nx pts_time:5.9 y";
  assert.deepEqual(parseCuts(stderr, 6, 0.8), [2, 4.04]);
  assert.deepEqual(shotsOf([2, 4.04], 6), [{ inSec: 0, outSec: 2 }, { inSec: 2, outSec: 4.04 }, { inSec: 4.04, outSec: 6 }]);
});

test("命令登记：media/detectScenes、media/clipToCanvas 在白名单里", () => {
  for (const c of ["media/detectScenes", "media/clipToCanvas"]) assert.ok(canvasBootstrap.RENDERER_COMMANDS.includes(c), c);
});

test("参数校验：不是视频 data URL 直接拒绝", async () => {
  assert.equal((await detectScenes({ dataUrl: "data:image/png;base64,AAAA" })).error, "INVALID_INPUT");
  assert.equal((await clipToCanvas({ dataUrl: "data:video/mp4;base64,AAAA", segments: [] }, { canvasService: { importAsset: async () => ({}) } })).error, "INVALID_INPUT");
  assert.equal((await clipToCanvas({ dataUrl: "x" }, {})).error, "RESOURCE_UNAVAILABLE");
});

test("真实视频：检测出 3 个镜头", { skip: !ready && "没有 ffmpeg" }, async () => {
  const r = await detectScenes({ dataUrl: dataUrl(), tmpDir: ROOT });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.cuts.length, 2);
  assert.ok(Math.abs(r.cuts[0] - 2) < 0.15 && Math.abs(r.cuts[1] - 4) < 0.15, JSON.stringify(r.cuts));
  assert.equal(r.shots.length, 3);
});

test("真实视频：按段裁剪后存进资源库，临时文件删除", { skip: !ready && "没有 ffmpeg" }, async () => {
  const imported = [];
  const canvasService = { importAsset: async ({ canvasId, name, dataUrl: d }) => { imported.push({ canvasId, name, bytes: d.length }); return { ok: true, ref: "openarc-asset:r" + imported.length }; } };
  const r = await clipToCanvas({ canvasId: "c1", dataUrl: dataUrl(), segments: [{ inSec: 0, outSec: 2 }, { inSec: 4, outSec: 6 }, { inSec: 3, outSec: 3.05 }], fileName: "片子" }, { canvasService, context: {}, tmpDir: ROOT });
  assert.equal(r.ok, true);
  assert.deepEqual(r.clips.map((c) => c.ref || c.error), ["openarc-asset:r1", "openarc-asset:r2", "INVALID_RANGE"]);
  assert.ok(Math.abs(r.clips[0].duration - 2) < 0.2);
  assert.equal(imported[0].canvasId, "c1"); assert.match(imported[0].name, /^片子 0s-2s\.mp4$/);
  const left = fs.existsSync(path.join(ROOT, "openarc-clips")) ? fs.readdirSync(path.join(ROOT, "openarc-clips")) : [];
  assert.deepEqual(left, []);
});

test("切镜上限：切点最多 MAX_SEGMENTS-1 个；clipToCanvas 源视频只写一次，超出的段数如实返回", async () => {
  const { MAX_SEGMENTS } = require("../electron/media-scenes.cjs"); const clip = clipToCanvas;
  const stderr = Array.from({ length: 80 }, (_, i) => `pts_time:${(i + 1) * 2}`).join("\n");
  assert.equal(parseCuts(stderr, 400).length, MAX_SEGMENTS - 1);
  const seen = new Set();
  const clipImpl = async ({ srcPath, inSec, outSec }) => { assert.ok(srcPath && fs.existsSync(srcPath)); seen.add(srcPath); const p = path.join(ROOT, "oa-clip-" + inSec + ".mp4"); fs.writeFileSync(p, "x"); return { ok: true, path: p, duration: outSec - inSec, inSec, outSec }; };
  const canvasService = { importAsset: async () => ({ ok: true, ref: "openarc-asset:r" }) };
  const segs = Array.from({ length: MAX_SEGMENTS + 2 }, (_, i) => ({ inSec: i, outSec: i + 1 }));
  const r = await clip({ canvasId: "c", dataUrl: "data:video/mp4;base64,AAAA", segments: segs }, { canvasService, context: {}, clipImpl, tmpDir: ROOT });
  assert.equal(r.clips.length, MAX_SEGMENTS); assert.equal(r.dropped, 2); assert.equal(seen.size, 1, "所有段共用一个源文件");
  assert.ok(![...seen].some((p) => fs.existsSync(p)), "源文件用完删除");
});
