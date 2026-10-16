// 视频剪辑：FFmpeg 参数模板是纯函数，入出点 / 分辨率 / 无音轨片段都走固定模板。
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { buildExportArgs, createVideoService } = require("../electron/video-service.cjs");

test("每个片段用 -ss/-t 截取，无音轨片段补静音，统一缩放到目标分辨率", () => {
  const args = buildExportArgs(
    [
      { path: "/a.mp4", start: 1, end: 3.5, hasAudio: true, width: 640, height: 360 },
      { path: "/b.mov", start: 0, end: 2, hasAudio: false, width: 480, height: 640 },
    ],
    { resolution: "720p", outPath: "/out.mp4" },
  );
  assert.deepEqual(args.slice(3, 9), ["-ss", "1.000", "-t", "2.500", "-i", "/a.mp4"]);
  const fc = args[args.indexOf("-filter_complex") + 1];
  assert.match(fc, /scale=1280:720/);
  assert.match(fc, /anullsrc=channel_layout=stereo:sample_rate=48000,atrim=0:2\.000\[a1\]/);
  assert.match(fc, /\[v0\]\[a0\]\[v1\]\[a1\]concat=n=2:v=1:a=1/);
  assert.equal(args.at(-1), "/out.mp4");
});

test("原始分辨率取第一个片段并取偶数", () => {
  const args = buildExportArgs([{ path: "/a", start: 0, end: 1, hasAudio: true, width: 641, height: 359 }], { resolution: "source", outPath: "/o" });
  assert.match(args[args.indexOf("-filter_complex") + 1], /scale=642:360/);
});

test("找不到 FFmpeg 时如实报告不可用、导出拒绝", async () => {
  const v = createVideoService({ env: { PATH: "/nonexistent", OPENARC_FFMPEG_DIR: "/nonexistent" } });
  // 机器上若在固定目录装了 FFmpeg，这条只断言形状
  const s = await v.status();
  assert.equal(s.ok, true);
  assert.equal(typeof s.available, "boolean");
  assert.equal((await v.exportClips([], {})).error, s.available ? "INVALID_INPUT" : "FFMPEG_MISSING");
  assert.equal(v.cancel().error, "NO_JOB");
});
