/**
 * task-72：视频「使用区间」按 ffmpeg 真裁剪（media/clipVideo）。
 *
 * 覆盖：
 *   ① 参数校验 / INVALID_RANGE / INVALID_FORMAT / SOURCE_NOT_FOUND；
 *   ② FFMPEG_MISSING（显式路径不存在）；
 *   ③ 真实 5s 视频裁剪 1s→4s：-c copy 成功，ffprobe 校验输出时长 ≈3s；
 *   ④ 关键帧稀疏导致 copy 时长偏差 >0.12s → 自动退 libx264 重编码，ffprobe 仍 ≈3s；
 *   ⑤ in/out clamp 到 [0,dur]；
 *   ⑥ dataUrl 输入：临时文件在结束后清理；
 *   ⑦ 重名不覆盖（第二次 -1 后缀）；
 *   ⑧ 超时 → FFMPEG_TIMEOUT；
 *   ⑨ 命令 media/clipVideo 已登记并正确转发（注入假实现）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { clipVideo, findFfmpeg, findFfprobe } = require("../electron/media-clip.cjs");
const canvasBootstrap = require("../electron/canvas-bootstrap.cjs");

const FFMPEG = findFfmpeg();
const FFPROBE = FFMPEG ? findFfprobe(null, FFMPEG) : null;
const HAS_FFMPEG = !!(FFMPEG && FFPROBE);
const run = (file, args) => spawnSync(file, args, { encoding: "utf8" });

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "oa-clip-test-"));
const FIXTURE = path.join(ROOT, "fixture-5s.mp4");
const SPARSE = path.join(ROOT, "fixture-sparse.mp4");
const REAL = path.join(ROOT, "out");

function makeFixture() {
  // 导播视频：每秒一个关键帧，copy 的 1s 对齐 → 应走流复制
  const base = ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25", "-t", "5", "-g", "25", "-keyint_min", "25", "-sc_threshold", "0", "-c:v", "libx264", "-pix_fmt", "yuv420p"];
  const a = run(FFMPEG, [...base, FIXTURE]);
  // 只有一个关键帧：copy 出来的时长会偏，验证自动重编码
  const b = run(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25", "-t", "5", "-g", "250", "-keyint_min", "250", "-sc_threshold", "0", "-c:v", "libx264", "-pix_fmt", "yuv420p", SPARSE]);
  return a.status === 0 && b.status === 0;
}
const fixturesReady = HAS_FFMPEG && makeFixture();
const probeDuration = (file) => {
  const out = run(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file]);
  const value = Number(String(out.stdout || "").trim());
  return Number.isFinite(value) ? value : null;
};

test.after(() => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ } });

test("① 参数校验：二选一、格式、源文件、区间、数字", async () => {
  const none = await clipVideo({ inSec: 1, outSec: 2 });
  assert.equal(none.ok, false); assert.equal(none.error, "INVALID_INPUT");
  const both = await clipVideo({ srcPath: FIXTURE, dataUrl: "data:video/mp4;base64,AAAA", inSec: 1, outSec: 2 });
  assert.equal(both.error, "INVALID_INPUT");
  const badFormat = await clipVideo({ srcPath: FIXTURE, inSec: 1, outSec: 2, format: "mkv" });
  assert.equal(badFormat.error, "INVALID_FORMAT");
  const missing = await clipVideo({ srcPath: path.join(ROOT, "nope.mp4"), inSec: 1, outSec: 2 });
  assert.equal(missing.error, "SOURCE_NOT_FOUND");
  const badNum = await clipVideo({ srcPath: FIXTURE, inSec: "abc", outSec: 2 });
  assert.equal(badNum.error, "INVALID_INPUT");
  const badRange = await clipVideo({ srcPath: FIXTURE, inSec: 3, outSec: 3.1, tmpDir: REAL });
  assert.equal(badRange.error, "INVALID_RANGE");
});

test("② 没有 ffmpeg：结构化 FFMPEG_MISSING（调用方据此降级）", async () => {
  const out = await clipVideo({ srcPath: FIXTURE, inSec: 1, outSec: 2, ffmpegPath: path.join(ROOT, "no-ffmpeg"), tmpDir: REAL });
  assert.equal(out.ok, false);
  assert.equal(out.error, "FFMPEG_MISSING");
  assert.match(out.detail, /ffmpeg/);
});

test("③ 真实 5s 视频裁 1s→4s：copy 成功，ffprobe 时长 ≈3s，文件名带区间", { skip: !fixturesReady }, async () => {
  const out = await clipVideo({ srcPath: FIXTURE, inSec: 1, outSec: 4, fileName: "演示", tmpDir: REAL });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.mode, "copy", "关键帧对齐时优先流复制");
  assert.match(out.path, /演示-1s-4s\.mp4$/);
  assert.ok(out.bytes > 0);
  const measured = probeDuration(out.path);
  assert.ok(Math.abs(measured - 3) <= 0.2, "输出时长应≈3s，实际 " + measured);
  assert.ok(Math.abs(out.duration - measured) <= 0.05, "返回值时长应与 ffprobe 一致");
});

test("④ 关键帧稀疏：copy 时长偏差 → 自动退 libx264 重编码，时长仍对", { skip: !fixturesReady }, async () => {
  const out = await clipVideo({ srcPath: SPARSE, inSec: 0.5, outSec: 1.5, fileName: "稀疏", tmpDir: REAL });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.mode, "reencode", "关键帧不精确必须退重编码");
  const measured = probeDuration(out.path);
  assert.ok(Math.abs(measured - 1) <= 0.2, "重编码后时长应≈1s，实际 " + measured);
  assert.ok(Math.abs(out.inSec - 0.5) < 0.01 && Math.abs(out.outSec - 1.5) < 0.01);
});

test("⑤ in/out clamp 到 [0,dur]（越界不报参数错）", { skip: !fixturesReady }, async () => {
  const out = await clipVideo({ srcPath: FIXTURE, inSec: -5, outSec: 99, fileName: "clamp", tmpDir: REAL });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.inSec, 0);
  assert.ok(Math.abs(out.outSec - 5) <= 0.05, "outSec 应夹到源时长，实际 " + out.outSec);
  const measured = probeDuration(out.path);
  assert.ok(Math.abs(measured - 5) <= 0.25);
});

test("⑥ dataUrl 输入：结束后清理临时输入目录，输出保留", { skip: !fixturesReady }, async () => {
  const bytes = fs.readFileSync(FIXTURE);
  const before = fs.readdirSync(REAL).filter((name) => name.startsWith("openarc-clip-in-"));
  const out = await clipVideo({ dataUrl: "data:video/mp4;base64," + bytes.toString("base64"), inSec: 1, outSec: 3, fileName: "内联", tmpDir: REAL });
  assert.equal(out.ok, true, JSON.stringify(out));
  const after = fs.readdirSync(REAL).filter((name) => name.startsWith("openarc-clip-in-"));
  assert.deepEqual(after, before, "临时输入目录必须清理");
  assert.equal(fs.existsSync(out.path), true, "输出文件要保留");
});

test("⑦ 重名不覆盖：同一区间第二次输出 -1 后缀", { skip: !fixturesReady }, async () => {
  const first = await clipVideo({ srcPath: FIXTURE, inSec: 2, outSec: 3, fileName: "重复", tmpDir: REAL });
  const second = await clipVideo({ srcPath: FIXTURE, inSec: 2, outSec: 3, fileName: "重复", tmpDir: REAL });
  assert.equal(first.ok, true); assert.equal(second.ok, true);
  assert.notEqual(first.path, second.path);
  assert.match(second.path, /-1\.mp4$/);
  assert.equal(fs.existsSync(first.path), true);
});

test("⑧ 超时：假 ffmpeg 睡 5s + timeoutMs=200 → FFMPEG_TIMEOUT", { skip: !fixturesReady }, async () => {
  const script = path.join(ROOT, "ffmpeg-sleep.sh");
  fs.writeFileSync(script, "#!/bin/sh\nsleep 5\n", { mode: 0o755 });
  const out = await clipVideo({ srcPath: FIXTURE, inSec: 1, outSec: 2, ffmpegPath: script, timeoutMs: 200, tmpDir: REAL });
  assert.equal(out.ok, false);
  assert.equal(out.error, "FFMPEG_TIMEOUT");
});

test("⑨ 命令 media/clipVideo 已登记，并把参数转发给裁剪实现", async () => {
  assert.ok(canvasBootstrap.RENDERER_COMMANDS.includes("media/clipVideo"));
  let handler = null;
  let seen = null;
  const ipcMain = { handle: (channel, fn) => { if (channel === "canvas:command") handler = fn; }, removeHandler: () => {} };
  canvasBootstrap.registerCanvasIpc({
    ipcMain, service: {}, identity: { current: null }, isTrusted: () => true, clipDir: REAL,
    clipVideoImpl: async (input) => { seen = input; return { ok: true, path: "/tmp/fake-1s-2s.mp4", duration: 1, bytes: 10 }; },
  });
  const res = await handler({}, { command: "media/clipVideo", payload: { srcPath: FIXTURE, inSec: 1, outSec: 2, format: "mp4", fileName: "演示" } });
  assert.equal(res.ok, true);
  assert.deepEqual({ srcPath: seen.srcPath, inSec: seen.inSec, outSec: seen.outSec, format: seen.format, fileName: seen.fileName, tmpDir: seen.tmpDir }, {
    srcPath: FIXTURE, inSec: 1, outSec: 2, format: "mp4", fileName: "演示", tmpDir: REAL,
  });
});
