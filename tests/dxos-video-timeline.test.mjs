/**
 * task-20 · 多轨时间线（视频/音频/字幕轨、clip in/out、转场、时长对齐、渲染计划→真实 FFmpeg）+ Agent 粗剪。
 * 离线：ffmpeg/ffprobe 只跑本机生成的小样本；模型/脚本用注入适配器。
 */
import { test, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { IdentityStore } = require("../electron/identity-store.cjs");
const mediaDomain = require("../electron/media-domain.cjs");
const mediaStore = require("../electron/media-store.cjs");
const { createMediaBundle } = require("../electron/media-service.cjs");
const { buildExportArgs } = require("../electron/video-service.cjs");

const tmpDirs = [];
const openStores = [];
afterEach(() => {
  mediaStore.resetMediaStoreForTests();
  while (openStores.length) { try { openStores.pop().close(); } catch { /* 已关 */ } }
});
after(() => { while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true }); });
function tempDir(prefix) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tmpDirs.push(dir); return dir; }
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";

let SAMPLE = null;
function sampleBuffer() {
  if (SAMPLE) return SAMPLE;
  const dir = tempDir("dxos-video-timeline-sample-");
  const file = path.join(dir, "sample.mp4");
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc=size=160x120:rate=10:duration=1",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
    "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", file]);
  SAMPLE = fs.readFileSync(file);
  return SAMPLE;
}

function makeAuth() {
  return { resolveActor({ context }) { return context && context.sessionRef ? { ok: true, user: { id: "u-video" } } : { ok: false, error: "no-session" }; } };
}
function openBundle(overrides = {}) {
  const dir = tempDir("dxos-video-timeline-bundle-");
  const store = new IdentityStore({ path: path.join(dir, "identity.db") }).open();
  openStores.push(store);
  const bundle = createMediaBundle(Object.assign({ userDataDir: dir, identityStore: store, authorization: makeAuth() }, overrides));
  return {
    dir, store, bundle,
    dxosMedia: path.join(dir, "dxos", "media"),
    call: (command, payload) => bundle.execute(command, payload || {}, { sessionRef: "sess-video", requestId: "req-video" }),
  };
}

async function seedAssets(fx) {
  const buffer = sampleBuffer();
  const video = await fx.call("media/asset/save", { projectId: PROJECT_ID, name: "a.mp4", mime: "video/mp4", base64: buffer.toString("base64") });
  assert.equal(video.ok, true, JSON.stringify(video));
  const subtitle = await fx.call("media/asset/save", { projectId: PROJECT_ID, name: "a.srt", mime: "application/x-subrip", base64: Buffer.from("1\n00:00:00,000 --> 00:00:01,000\nhello\n").toString("base64") });
  assert.equal(subtitle.ok, true, JSON.stringify(subtitle));
  return { videoAssetId: video.value.asset.id, subtitleAssetId: subtitle.value.asset.id };
}

function multiTrackTimeline({ videoAssetId, subtitleAssetId, durationMs = 500, invalidTransition = false }) {
  return {
    schemaVersion: "1.0", projectId: PROJECT_ID, version: 2, timebase: 1000,
    canvas: { width: 160, height: 120, fps: 10 }, durationMs, outputProfileId: "default", updatedAt: 1,
    tracks: [
      { id: "tv", type: "video", name: "主视频", order: 0, locked: false, muted: false, hidden: false, clips: [
        { id: "v1", trackId: "tv", assetId: videoAssetId, name: "A", timelineStartMs: 0, durationMs: 500, sourceInMs: 0, sourceOutMs: 500, volume: 1 },
        { id: "v2", trackId: "tv", assetId: videoAssetId, name: "B", timelineStartMs: 500, durationMs: 500, sourceInMs: 500, sourceOutMs: 1000, volume: 1, transitionIn: invalidTransition ? { type: "dissolve", durationMs: 5000 } : { type: "fade", durationMs: 200 } },
      ] },
      { id: "tm", type: "music", name: "配乐", order: 1, locked: false, muted: false, hidden: false, clips: [
        { id: "m1", trackId: "tm", assetId: videoAssetId, name: "BGM", timelineStartMs: 0, durationMs: 1000, sourceInMs: 0, sourceOutMs: 1000, volume: 0.4, transitionIn: { type: "fade", durationMs: 200 } },
      ] },
      { id: "ts", type: "subtitle", name: "字幕", order: 2, locked: false, muted: false, hidden: false, clips: [
        { id: "s1", trackId: "ts", assetId: subtitleAssetId, name: "字幕", timelineStartMs: 0, durationMs: 1000, sourceInMs: 0, sourceOutMs: 1000, volume: 1 },
      ] },
    ],
    transitions: [{ fromClipId: "v1", toClipId: "v2", type: "dissolve", durationMs: 200 }],
  };
}

test("① 时长对齐：durationMs 抬到片段最大结束时间；显式更长时保留", () => {
  const assets = [{ id: "a", kind: "video", hasAudio: true, durationMs: 5000, name: "a" }];
  const short = multiTrackTimeline({ videoAssetId: "a", subtitleAssetId: "a" });
  const aligned = mediaDomain.alignTimelineDuration(short);
  assert.equal(aligned.changed, true);
  assert.equal(aligned.timeline.durationMs, 1000);
  assert.equal(short.durationMs, 500, "不得原地修改输入");
  const longer = { ...short, durationMs: 3000 };
  assert.equal(mediaDomain.alignTimelineDuration(longer).changed, false);
  assert.equal(mediaDomain.alignTimelineDuration({ tracks: [] }).timeline.durationMs, 0);
});

test("① 转场校验：合法 fade/dissolve；非法类型 / 超长 / 跨轨 / 缺片段全部报 error", () => {
  const assets = [{ id: "a", kind: "video", hasAudio: true, durationMs: 5000, name: "a" }];
  const valid = mediaDomain.alignTimelineDuration(multiTrackTimeline({ videoAssetId: "a", subtitleAssetId: "a" })).timeline;
  assert.deepEqual(mediaDomain.validateTimeline(valid, assets).filter((entry) => entry.severity === "error"), []);

  const invalidType = JSON.parse(JSON.stringify(valid));
  invalidType.tracks[0].clips[1].transitionIn = { type: "wipe", durationMs: 200 };
  assert.ok(mediaDomain.validateTimeline(invalidType, assets).some((entry) => entry.code === "clip.transition.invalid"));

  const tooLong = mediaDomain.alignTimelineDuration(multiTrackTimeline({ videoAssetId: "a", subtitleAssetId: "a", invalidTransition: true })).timeline;
  assert.ok(mediaDomain.validateTimeline(tooLong, assets).some((entry) => entry.code === "clip.transition.too_long"));

  const missing = JSON.parse(JSON.stringify(valid));
  missing.transitions = [{ fromClipId: "nope", toClipId: "v2", type: "fade", durationMs: 100 }];
  assert.ok(mediaDomain.validateTimeline(missing, assets).some((entry) => entry.code === "transition.clip_missing"));

  const crossTrack = JSON.parse(JSON.stringify(valid));
  crossTrack.transitions = [{ fromClipId: "m1", toClipId: "v2", type: "fade", durationMs: 100 }];
  assert.ok(mediaDomain.validateTimeline(crossTrack, assets).some((entry) => entry.code === "transition.cross_track"));
});

test("② 渲染计划：多轨输入 + 转场 + 对齐后时长；FFmpeg 参数含 fade/afade", () => {
  const assets = [
    { id: "a", kind: "video", hasAudio: true, durationMs: 5000, name: "a" },
    { id: "s", kind: "subtitle", hasAudio: false, durationMs: 0, name: "s" },
  ];
  const plan = mediaDomain.compileRenderPlan(multiTrackTimeline({ videoAssetId: "a", subtitleAssetId: "s" }), assets, (asset) => "/tmp/media/" + asset.id + ".mp4");
  assert.equal(plan.durationMs, 1000);
  assert.equal(plan.durationAligned, true);
  assert.equal(plan.inputs.length, 4);
  assert.deepEqual(plan.inputs.map((input) => input.trackType), ["video", "video", "music", "subtitle"]);
  const v2 = plan.inputs.find((input) => input.clipId === "v2");
  assert.deepEqual(v2.transition, { type: "dissolve", durationMs: 200 });
  const m1 = plan.inputs.find((input) => input.clipId === "m1");
  assert.deepEqual(m1.transition, { type: "fade", durationMs: 200 });
  const args = mediaDomain.buildFfmpegArgs(plan, "/tmp/media/out.mp4");
  const joined = args.join(" ");
  assert.ok(joined.includes("fade=t=in:st=0.500:d=0.200:alpha=1"), "dissolve 必须走 alpha fade");
  assert.ok(joined.includes("afade=t=in:st=0.000:d=0.200"), "音频转场必须 afade");
  assert.ok(joined.includes("subtitles='"), "字幕轨必须进滤镜链");
});

test("③ timeline/validate + render/plan 命令：对齐/多轨/转场；不回绝对路径", async () => {
  const fx = openBundle();
  const { videoAssetId, subtitleAssetId } = await seedAssets(fx);
  const timeline = multiTrackTimeline({ videoAssetId, subtitleAssetId });

  const validated = await fx.call("media/timeline/validate", { projectId: PROJECT_ID, timeline });
  assert.equal(validated.ok, true, JSON.stringify(validated));
  assert.equal(validated.value.durationMs, 1000);
  assert.equal(validated.value.changed, true);
  assert.deepEqual(validated.value.issues.filter((entry) => entry.severity === "error"), []);

  const planned = await fx.call("media/render/plan", { projectId: PROJECT_ID, timeline });
  assert.equal(planned.ok, true, JSON.stringify(planned));
  assert.equal(planned.value.durationMs, 1000);
  assert.equal(planned.value.durationAligned, true);
  assert.equal(planned.value.inputCount, 4);
  assert.equal(planned.value.plan.inputs[0].path, undefined, "计划预览不得带磁盘路径");
  assert.equal(JSON.stringify(planned).includes(fx.dir), false);
  assert.deepEqual(planned.value.plan.inputs.find((input) => input.clipId === "v2").transition, { type: "dissolve", durationMs: 200 });

  const invalid = await fx.call("media/timeline/validate", { projectId: PROJECT_ID, timeline: multiTrackTimeline({ videoAssetId, subtitleAssetId, invalidTransition: true }) });
  assert.equal(invalid.ok, true);
  assert.ok(invalid.value.issues.some((entry) => entry.code === "clip.transition.too_long"));
});

test("④ Agent 粗剪：未注入结构化不可用；注入脚本/模型后产出可校验多轨时间线", async () => {
  const noAdapter = openBundle();
  const assets = await seedAssets(noAdapter);
  const missing = await noAdapter.call("media/rough-cut", { projectId: PROJECT_ID, instruction: "把素材粗剪成 1 秒" });
  assert.equal(missing.ok, false, JSON.stringify(missing));
  assert.equal(missing.error, "MEDIA_DEPENDENCY_UNAVAILABLE");
  assert.equal(missing.detail && missing.detail.dependency, "roughCut");

  let seen = null;
  let adapterAssets = null;
  const withAdapter = openBundle({
    roughCut: async (input) => {
      seen = input;
      return { provider: "scripted", timeline: multiTrackTimeline({ videoAssetId: adapterAssets.videoAssetId, subtitleAssetId: adapterAssets.subtitleAssetId }) };
    },
  });
  // 适配器 bundle 需要同一批素材：重新播种（各自独立项目）
  adapterAssets = await seedAssets(withAdapter);
  const rough = await withAdapter.call("media/rough-cut", { projectId: PROJECT_ID, instruction: "粗剪", durationMs: 1000 });
  assert.equal(rough.ok, true, JSON.stringify(rough));
  assert.equal(rough.value.mode, "rough-cut");
  assert.equal(rough.value.durationMs, 1000);
  assert.equal(rough.value.timeline.tracks.length, 3);
  assert.equal(rough.value.timeline.tracks[0].clips.length, 2);
  assert.equal(rough.value.adapter, "scripted");
  assert.equal(seen.instruction, "粗剪");
  assert.equal(seen.assets.every((asset) => asset.path === undefined), true, "粗剪输入不得带磁盘路径");
  assert.equal(JSON.stringify(rough).includes(withAdapter.dir), false);

  const broken = openBundle({ roughCut: async () => ({ tracks: [{ id: "bad" }] }) });
  await seedAssets(broken);
  const invalid = await broken.call("media/rough-cut", { projectId: PROJECT_ID, instruction: "粗剪" });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error, "MEDIA_INVALID_INPUT");

  // 未注入脚本但注入了模型出口：走内建语言模型适配器（providerStore + modelGateway）。
  let modelTimeline = null;
  const provider = { id: "prov_1", base_url: "https://api.example.com", api_key: "sk-test", protocol: "openai", models: [{ model: "vision-llm", caps: ["llm"] }] };
  const modelBundle = openBundle({
    providerStore: { firstUsableProvider: (caps) => (caps === "llm" ? provider : null) },
    modelGateway: { callChat: async () => ({ text: "这里的时间线：\n" + JSON.stringify(modelTimeline) }) },
  });
  const modelAssets = await seedAssets(modelBundle);
  modelTimeline = multiTrackTimeline({ videoAssetId: modelAssets.videoAssetId, subtitleAssetId: modelAssets.subtitleAssetId });
  const modeled = await modelBundle.call("media/rough-cut", { projectId: PROJECT_ID, instruction: "模型粗剪" });
  assert.equal(modeled.ok, true, JSON.stringify(modeled));
  assert.equal(modeled.value.adapter, "model");
  assert.equal(modeled.value.timeline.tracks.length, 3);
});

test("⑤ 真实 FFmpeg：多轨 + 转场 submit → run 合成成功，存储时间线已对齐", async () => {
  const fx = openBundle();
  const { videoAssetId } = await seedAssets(fx);
  const timeline = multiTrackTimeline({ videoAssetId, subtitleAssetId: videoAssetId, durationMs: 500 });
  // 去掉字幕轨（libass 非所有 ffmpeg 构建都有），保留视频双片段 + 音乐轨 + 转场。
  timeline.tracks = timeline.tracks.filter((track) => track.type !== "subtitle");
  const submitted = await fx.call("media/render/submit", { projectId: PROJECT_ID, timeline });
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  const jobId = submitted.value.job.id;
  const row = mediaStore.getVideoRenderJob(jobId, "u-video");
  const stored = JSON.parse(row.timeline_json);
  assert.equal(stored.durationMs, 1000, "入队时已做时长对齐");

  const ran = await fx.call("media/render/run", {});
  assert.equal(ran.ok, true, JSON.stringify(ran));
  assert.equal(ran.value.ran, true);
  assert.equal(ran.value.job.id, jobId, JSON.stringify(ran.value.job));
  assert.equal(ran.value.job.status, "completed", JSON.stringify(ran.value.job));
  const outputFile = path.join(fx.dxosMedia, "renders", ran.value.job.outputRelativePath);
  assert.equal(fs.existsSync(outputFile), true);
  assert.ok(fs.statSync(outputFile).size > 0);
});

test("⑥ 单轨快速模式保持：video-service 的 concat 参数不被多轨改动影响", () => {
  const args = buildExportArgs([
    { path: "/tmp/a.mp4", start: 0, end: 1, hasAudio: true, width: 160, height: 120 },
    { path: "/tmp/b.mp4", start: 0, end: 1, hasAudio: false, width: 160, height: 120 },
  ], { resolution: "480p", outPath: "/tmp/out.mp4" });
  const joined = args.join(" ");
  assert.ok(joined.includes("concat=n=2:v=1:a=1"), "单轨快速模式仍是 concat");
  assert.equal(joined.includes("xfade"), false, "单轨快速模式不得引入多轨转场");
  assert.ok(joined.includes("-map [vout]"));
});
