/**
 * 10-29 剪辑时间线：多轨时间线 + 切开 + 转场 / 音量 + 画幅 + 随包 ffmpeg。
 *   · timelineModel：吸附轨排布、交叉溶解重叠、切开、拖动排序、修剪上限、字幕平移、渲染计划、SRT、画幅尺寸
 *   · 随包二进制：resources/bin 下的 ffmpeg / ffprobe 优先于本机安装
 *   · sync-app 打包时复制二进制；节点用新编辑器
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const tl = await import("../src/canvas/canvas-next/timelineModel.ts");
const read = (p) => fs.readFileSync(new URL("../" + p, import.meta.url), "utf8");

const v = (id, inP, outP, order, extra = {}) => ({ id, sourceNodeId: "n", url: "openarc-asset:" + id, mediaKind: "video", inPoint: inP, outPoint: outP, order, ...extra });
const a = (id, inP, outP, order, extra = {}) => ({ ...v(id, inP, outP, order, extra), mediaKind: "audio" });
const sub = (id, start, end, text = "字幕") => ({ id, sourceNodeId: "", url: "", mediaKind: "video", inPoint: 0, outPoint: 1, order: 0, type: "subtitle", text, start, end });

test("吸附轨：视频、音频各自从 0 首尾相接；总长取最长一轨（含字幕）", () => {
  const clips = [v("v1", 0, 4, 0), v("v2", 1, 3, 1), a("a1", 0, 5, 0), sub("s1", 6, 7)];
  assert.deepEqual(tl.place(clips, "video").map((p) => [p.clip.id, p.start, p.end]), [["v1", 0, 4], ["v2", 4, 6]]);
  assert.deepEqual(tl.place(clips, "audio").map((p) => [p.start, p.end]), [[0, 5]]);
  assert.equal(tl.totalOf(clips), 7);
});

test("交叉溶解让后一段提前进场（重叠）；黑场淡入不重叠；转场时长不超过两段较短者的一半", () => {
  const dis = [v("v1", 0, 4, 0), v("v2", 0, 4, 1, { trans: "dissolve", transMs: 1000 })];
  assert.deepEqual(tl.place(dis, "video").map((p) => [p.start, p.end]), [[0, 4], [3, 7]]);
  const fade = [v("v1", 0, 4, 0), v("v2", 0, 4, 1, { trans: "fade", transMs: 1000 })];
  assert.deepEqual(tl.place(fade, "video").map((p) => [p.start, p.end]), [[0, 4], [4, 8]]);
  assert.equal(tl.transOf(v("x", 0, 1, 1, { trans: "dissolve", transMs: 2000 }), v("p", 0, 4, 0)).sec, 0.5);
  // 第一段的溶解按黑场淡入处理
  assert.equal(tl.transOf(v("x", 0, 4, 0, { trans: "dissolve", transMs: 500 })).kind, "fade");
});

test("在播放头处切开：只切压着播放头的片段，后半段从切点续上且不带转场", () => {
  const clips = [v("v1", 2, 8, 0), v("v2", 0, 4, 1, { trans: "fade", transMs: 500 }), sub("s1", 0, 10)];
  const r = tl.splitAt(clips, 3, undefined, (c) => c.id + "_b");
  const vids = tl.place(r.clips, "video").map((p) => [p.clip.id, p.clip.inPoint, p.clip.outPoint, p.start, p.end]);
  assert.deepEqual(vids, [["v1", 2, 5, 0, 3], ["v1_b", 5, 8, 3, 6], ["v2", 0, 4, 6, 10]]);
  assert.equal(r.clips.find((c) => c.id === "v1_b").trans, "none");
  assert.deepEqual(tl.place(r.clips, "subtitle").map((p) => [p.start, p.end]), [[0, 3], [3, 10]]);
  assert.deepEqual(r.made.sort(), ["s1_b", "v1_b"]);
  // 指定 id 只切那一段；播放头在片段边缘不切
  assert.deepEqual(tl.splitAt(clips, 3, "v1", (c) => c.id + "_b").made, ["v1_b"]);
  assert.deepEqual(tl.splitAt(clips, 6.05, "v1").made, []);
});

test("拖动排序：按拖动后中心点落位；字幕不参与排序", () => {
  const clips = [v("v1", 0, 2, 0), v("v2", 0, 2, 1), v("v3", 0, 2, 2)];
  const idx = tl.dropIndex(clips, "v3", 0.5);
  assert.equal(idx, 0);
  assert.deepEqual(tl.place(tl.moveTo(clips, "v3", idx), "video").map((p) => p.clip.id), ["v3", "v1", "v2"]);
  assert.deepEqual(tl.place(tl.moveTo(clips, "v1", tl.dropIndex(clips, "v1", 2.5)), "video").map((p) => p.clip.id), ["v2", "v1", "v3"]);
});

test("修剪：入点不小于 0、出点不超过素材长度、最短 0.1s；字幕可平移不越过 0", () => {
  const c = v("v1", 1, 4, 0, { srcDur: 5 });
  assert.equal(tl.trimEdge(c, "r", 10).outPoint, 5);
  assert.equal(tl.trimEdge(c, "l", -5).inPoint, 0);
  assert.equal(tl.trimEdge(c, "l", 10).inPoint, 3.9);
  const s = sub("s", 2, 4);
  assert.deepEqual([tl.shiftSub(s, -5).start, tl.shiftSub(s, -5).end], [0, 2]);
  assert.equal(tl.trimEdge(s, "r", -5).end, 2.1);
});

test("渲染计划：毫秒整数、片段位置 / 音量 / 进场转场；SRT 与画幅尺寸", () => {
  const clips = [v("v1", 0.5, 4.5, 0, { volume: 0.5 }), v("v2", 0, 4, 1, { trans: "dissolve", transMs: 800 }), a("a1", 0, 3, 0, { volume: 1.6 }), sub("s1", 0, 1.25, "你好")];
  const plan = tl.renderPlan(clips);
  const byId = Object.fromEntries(plan.clips.map((c) => [c.id, c]));
  assert.deepEqual(byId.v1, { id: "v1", url: "openarc-asset:v1", track: "video", timelineStartMs: 0, durationMs: 4000, sourceInMs: 500, sourceOutMs: 4500, volume: 0.5 });
  assert.equal(byId.v2.timelineStartMs, 3200);
  assert.deepEqual(byId.v2.transitionIn, { type: "dissolve", durationMs: 800 });
  assert.equal(byId.a1.volume, 1.6);
  assert.equal(plan.durationMs, 7200);
  assert.equal(tl.toSrt(clips), "1\n00:00:00,000 --> 00:00:01,250\n你好\n");
  assert.deepEqual(tl.frameSize("16:9", "1080p"), { width: 1920, height: 1080 });
  assert.deepEqual(tl.frameSize("9:16", "720p"), { width: 720, height: 1280 });
  assert.deepEqual(tl.frameSize("1:1", "720p"), { width: 720, height: 720 });
  assert.deepEqual(tl.frameSize("bogus", "720p"), { width: 1280, height: 720 });
});

test("随包 ffmpeg / ffprobe：resources/bin 下有就优先用；没有就退回原查找顺序", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-bin-"));
  for (const n of ["ffmpeg", "ffprobe"]) { fs.writeFileSync(path.join(dir, n), "#!/bin/sh\n"); fs.chmodSync(path.join(dir, n), 0o755); }
  const prev = process.env.OPENARC_BUNDLED_BIN_DIR;
  try {
    process.env.OPENARC_BUNDLED_BIN_DIR = dir;
    const { bundledBinary } = require("../electron/bundled-bin.cjs");
    assert.equal(bundledBinary("ffmpeg"), path.join(dir, "ffmpeg"));
    assert.equal(bundledBinary("ls"), null);
    const clip = require("../electron/media-clip.cjs");
    assert.equal(clip.findFfmpeg(), path.join(dir, "ffmpeg"));
    assert.equal(clip.findFfprobe(null, clip.findFfmpeg()), path.join(dir, "ffprobe"));
    const vs = require("../electron/video-service.cjs");
    assert.equal(vs.findBinary("ffmpeg", { PATH: "" }), path.join(dir, "ffmpeg"));
    process.env.OPENARC_BUNDLED_BIN_DIR = path.join(dir, "missing");
    assert.equal(bundledBinary("ffmpeg"), null);
  } finally {
    if (prev === undefined) delete process.env.OPENARC_BUNDLED_BIN_DIR; else process.env.OPENARC_BUNDLED_BIN_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const ms = read("electron/media-service.cjs");
  assert.match(ms, /const bundled = bundledBinary\(name\);\n  if \(bundled\) return bundled;/);
});

test("打包脚本复制 ffmpeg / ffprobe 到 resources/bin；依赖写在 optionalDependencies", () => {
  const sync = read("scripts/sync-app.mjs");
  assert.match(sync, /path\.join\(APPX, "resources", "bin"\)/);
  assert.match(sync, /pick\("ffmpeg", \(\) => req\("ffmpeg-static"\)\)/);
  assert.match(sync, /pick\("ffprobe", \(\) => req\("@ffprobe-installer\/ffprobe"\)\.path\)/);
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.optionalDependencies["ffmpeg-static"], "5.2.0");
  assert.equal(pkg.optionalDependencies["@ffprobe-installer/ffprobe"], "2.1.2");
  assert.match(read(".gitignore"), /^resources\/bin\/$/m);
});

test("时间线节点用新编辑器；导出 MP4 走按位置的渲染计划，WebM 和预览共用播放引擎", () => {
  assert.match(read("src/canvas/canvas-next/ui/LegacyNodes.tsx"), /export \{ TimelineEditor as TimelineBody \} from "\.\/TimelineEditor";/);
  const ed = read("src/canvas/canvas-next/ui/TimelineEditor.tsx");
  assert.match(ed, /exportPlanMp4\(\{ \.\.\.plan, srt: toSrt\(clips\), \.\.\.size,/);
  assert.match(ed, /recordWebM\(clips, size,/);
  assert.match(ed, /if \(e\.metaKey \|\| e\.ctrlKey\) return;/);
  const be = read("src/canvas/react-canvas/timelineExportBackend.ts");
  assert.match(be, /id: "video-sound", type: "voice"/);
  assert.match(be, /catch \(err\) \{ if \(!subTrack\) throw err; subtitlesDropped = true;/);
});
