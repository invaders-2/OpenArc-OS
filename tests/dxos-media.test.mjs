/**
 * B5a · 媒体域测试（全离线：真实 ffmpeg/ffprobe 只跑本机生成的小样本，无网络、无第三方服务）。
 *
 * 覆盖本轮验收条目：
 *   ① 命令表 risk/credential/summary（16 条）
 *   ② 渲染计划编译（轨道排序 / 过滤 / 绝对路径 / 非法拒绝）—— 源 renderPlan.ts:32-65、videoDomain.ts:108-153
 *   ③ buildFfmpegArgs 滤镜链 —— 源 renderPlan.ts:82-126
 *   ④ ffprobe 解析 —— 源 mediaProbe.ts:57-85
 *   ⑤ media/probe：真实 ffmpeg 生成样本 → 受监督 worker → 真实 ffprobe
 *   ⑥ 封面缓存命中与失效 —— 源 posterCache.ts:7-50
 *   ⑦ 租约：claim / heartbeat / 过期回收 / 再 claim —— 源 videoStore.ts:179-204
 *   ⑧ worker 失败 / 超时的结构化错误（绝不假成功）
 *   ⑨ 渲染提交 → 受监督子进程执行 → 成片落盘（submit / run / get 一致）
 *   ⑩ 全部 IPC 返回值不含绝对路径
 *
 * 只读源：electron/media-domain.cjs、media-store.cjs、media-service.cjs、video-render-worker.cjs。
 */
import { test, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const { DatabaseSync } = require("node:sqlite");
const { IdentityStore, SchemaTooNewError, SCHEMA_VERSION, MIGRATIONS } = require("../electron/identity-store.cjs");
const mediaDomain = require("../electron/media-domain.cjs");
const mediaStore = require("../electron/media-store.cjs");
const { createMediaBundle } = require("../electron/media-service.cjs");

const tmpDirs = [];
const openStores = [];
/** 每个用例都重建全局注入，避免共享单例把上一例的目录/时钟带进下一例。 */
afterEach(() => {
  mediaStore.resetMediaStoreForTests();
  while (openStores.length) { try { openStores.pop().close(); } catch { /* 已关 */ } }
});
after(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

let SAMPLE_PATH = null;
let SAMPLE_BUFFER = null;
/** 用真实 ffmpeg 生成 1 秒 160×120@10fps 的 H.264 + AAC 样本（离线）。 */
function sampleBuffer() {
  if (SAMPLE_BUFFER) return SAMPLE_BUFFER;
  const dir = tempDir("dxos-media-sample-");
  const file = path.join(dir, "sample.mp4");
  execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc=size=160x120:rate=10:duration=1",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
    "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", file,
  ]);
  SAMPLE_PATH = file;
  SAMPLE_BUFFER = fs.readFileSync(file);
  assert.ok(SAMPLE_BUFFER.length > 0, "样本视频必须非空");
  return SAMPLE_BUFFER;
}

/** 造一个精确停在 upTo 版本的真实库（与 tests/dxos-agent-migration.test.mjs 同形）。 */
function buildDb(file, upTo) {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON");
  for (const migration of MIGRATIONS) {
    if (migration.version > upTo) continue;
    if (typeof migration.run === "function") migration.run(db);
    else db.exec(migration.sql);
  }
  db.exec("PRAGMA user_version = " + upTo);
  return db;
}

const hasTable = (db, name) => !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);

function makeAuth() {
  return {
    resolveActor({ context }) {
      return context && context.sessionRef
        ? { ok: true, user: { id: "u-media" } }
        : { ok: false, error: "no-session" };
    },
  };
}

function openBundle(overrides = {}) {
  const dir = tempDir("dxos-media-bundle-");
  const store = new IdentityStore({ path: path.join(dir, "identity.db") }).open();
  openStores.push(store);
  const bundle = createMediaBundle(Object.assign({ userDataDir: dir, identityStore: store, authorization: makeAuth() }, overrides));
  return {
    dir,
    store,
    bundle,
    dxosMedia: path.join(dir, "dxos", "media"),
    call: (command, payload, ctx) => bundle.execute(command, payload || {}, Object.assign({ sessionRef: "sess-test", requestId: "req-test" }, ctx || {})),
  };
}

function videoTimeline(assetId, overrides = {}) {
  return Object.assign({
    schemaVersion: "1.0",
    projectId: PROJECT_ID,
    version: 1,
    timebase: 1000,
    canvas: { width: 160, height: 120, fps: 10 },
    durationMs: 1000,
    outputProfileId: "default",
    updatedAt: 1,
    tracks: [{
      id: "t1", type: "video", name: "主轨", order: 0, locked: false, muted: false, hidden: false,
      clips: [{ id: "c1", trackId: "t1", assetId, name: "片段", timelineStartMs: 0, durationMs: 1000, sourceInMs: 0, sourceOutMs: 1000, transform: {}, volume: 1 }],
    }],
  }, overrides);
}

// ── ⓪ 迁移 v24（只新增表 / 幂等 / 高版本拒开 / 失败整级回滚） ─────────────
test("迁移 v24：v23 老库升到 24、video_ 表只新增、重放幂等、高版本拒开、失败整级回滚", () => {
  assert.equal(SCHEMA_VERSION, 25);
  const dir = tempDir("dxos-media-mig-");
  const file = path.join(dir, "identity.db");
  const raw = buildDb(file, 23);
  raw.prepare("INSERT INTO dx_tasks(id,project_id,thread_id,title,instruction,status,resume_safe,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("dx_task_b5a", "proj", "thr", "t", "i", "queued", 1, 1, 1);
  raw.close();

  const store = new IdentityStore({ path: file }).open();
  assert.equal(store.schemaVersion, 25);
  for (const table of ["video_projects", "video_assets", "video_render_jobs"]) assert.ok(hasTable(store.connection, table), "缺少 " + table);
  assert.equal(store.connection.prepare("SELECT COUNT(*) AS c FROM dx_tasks").get().c, 1, "既有数据必须保留");
  // 降回 23 再重放 v24：IF NOT EXISTS 幂等
  store.connection.exec("PRAGMA user_version = 23");
  store.close();
  const again = new IdentityStore({ path: file }).open();
  assert.equal(again.schemaVersion, 25);
  assert.ok(hasTable(again.connection, "video_render_jobs"));
  assert.ok(!!again.connection.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_video_jobs_queue'").get(), "v24 索引必须存在");
  again.close();

  // 高版本拒开：user_version=26 > 25
  const tooNew = new DatabaseSync(file);
  tooNew.exec("PRAGMA user_version = 26");
  tooNew.close();
  assert.throws(() => new IdentityStore({ path: file }).open(), (error) => error instanceof SchemaTooNewError && error.code === "SCHEMA_TOO_NEW");

  // v24 失败 → 整级回滚：user_version 停 23，video_ 表不残留
  const dir2 = tempDir("dxos-media-mig-fail-");
  const file2 = path.join(dir2, "identity.db");
  buildDb(file2, 23).close();
  const failing = new IdentityStore({ path: file2, hooks: { onMigration: (version) => { if (version === 24) throw new Error("boom-v24"); } } });
  assert.throws(() => failing.open(), /boom-v24/);
  failing.close();
  const check = new DatabaseSync(file2);
  assert.equal(check.prepare("PRAGMA user_version").get().user_version, 23);
  for (const table of ["video_projects", "video_assets", "video_render_jobs"]) assert.equal(hasTable(check, table), false, "回滚后不得残留 " + table);
  check.close();
});

// ── ① 命令表 ─────────────────────────────────────────────────────────────
test("命令表：16 条命令、risk/credential/summary 合法", () => {
  const required = [
    "media/project/ensure", "media/asset/save", "media/asset/list", "media/asset/delete",
    "media/probe", "media/poster/get", "media/poster/invalidate",
    "media/render/submit", "media/render/get", "media/render/list", "media/render/run",
    "media/render/cancel", "media/render/heartbeat", "media/render/recover",
    "media/artifact/list", "media/health",
  ];
  const commands = mediaDomain.listMediaCommands();
  assert.equal(commands.length, required.length);
  for (const name of required) assert.ok(mediaDomain.isMediaCommand(name), "缺少命令：" + name);
  for (const entry of commands) {
    assert.ok(Object.prototype.hasOwnProperty.call(mediaDomain.RISK_LEVELS, entry.risk), "非法 risk：" + entry.risk);
    assert.equal(typeof entry.needsCredential, "boolean");
    assert.equal(entry.needsCredential, false, "媒体域全部本地处理，不触碰凭据");
    assert.ok(typeof entry.summary === "string" && entry.summary.length >= 8, "summary 必须是中文说明");
  }
  assert.equal(mediaDomain.mediaCommandRisk("media/render/submit"), "manage");
  assert.equal(mediaDomain.mediaCommandRisk("media/nope"), null);
});

// ── ② 渲染计划编译 ───────────────────────────────────────────────────────
test("compileRenderPlan：按 order 排序 / 跳过 hidden 与静音轨 / 解析绝对路径", () => {
  const assets = [
    { id: "a1", name: "视频", kind: "video", hasAudio: true, durationMs: 5000 },
    { id: "a2", name: "音频", kind: "audio", hasAudio: true, durationMs: 5000 },
    { id: "a3", name: "隐藏", kind: "video", hasAudio: true, durationMs: 5000 },
  ];
  const timeline = {
    schemaVersion: "1.0", projectId: PROJECT_ID, version: 3, timebase: 1000,
    canvas: { width: 640, height: 360, fps: 30 }, durationMs: 5000, outputProfileId: "p",
    tracks: [
      { id: "tv", type: "video", name: "视频", order: 2, locked: false, muted: false, hidden: false, clips: [{ id: "c1", trackId: "tv", assetId: "a1", name: "v", timelineStartMs: 0, durationMs: 5000, sourceInMs: 0, sourceOutMs: 5000, volume: 1 }] },
      { id: "ta", type: "music", name: "音乐", order: 1, locked: false, muted: false, hidden: false, clips: [{ id: "c2", trackId: "ta", assetId: "a2", name: "a", timelineStartMs: 0, durationMs: 5000, sourceInMs: 0, sourceOutMs: 5000, volume: 0.5 }] },
      { id: "th", type: "video", name: "隐藏", order: 3, locked: false, muted: false, hidden: true, clips: [{ id: "c3", trackId: "th", assetId: "a3", name: "h", timelineStartMs: 0, durationMs: 5000, sourceInMs: 0, sourceOutMs: 5000, volume: 1 }] },
      { id: "tm", type: "music", name: "静音", order: 4, locked: false, muted: true, hidden: false, clips: [{ id: "c4", trackId: "tm", assetId: "a2", name: "m", timelineStartMs: 0, durationMs: 5000, sourceInMs: 0, sourceOutMs: 5000, volume: 1 }] },
    ],
  };
  const plan = mediaDomain.compileRenderPlan(timeline, assets, (asset) => "/tmp/media-root/" + asset.id + ".bin");
  // 只剩 order1 的音乐 + order2 的视频；隐藏与静音被跳过
  assert.deepEqual(plan.inputs.map((input) => input.assetId), ["a2", "a1"]);
  assert.equal(plan.inputs[0].index, 0);
  assert.equal(plan.inputs[1].index, 1);
  assert.equal(plan.inputs[1].path, "/tmp/media-root/a1.bin");
  assert.equal(plan.timelineVersion, 3);
  assert.equal(plan.canvas.width, 640);
});

test("compileRenderPlan：时间线非法 / 无素材 / 无可视片段一律 MEDIA_INVALID_INPUT", () => {
  const assets = [{ id: "a1", name: "视频", kind: "video", hasAudio: true, durationMs: 5000 }];
  const bad = videoTimeline("a1");
  bad.schemaVersion = "9.9";
  assert.throws(() => mediaDomain.compileRenderPlan(bad, assets, () => "/tmp/x.bin"), (error) => {
    assert.equal(error.code, "MEDIA_INVALID_INPUT");
    return true;
  });
  // 缺素材：源 renderPlan.ts:33-34 先跑 validateTimeline，命中 clip.asset.missing 即统一回 INVALID_INPUT
  assert.throws(() => mediaDomain.compileRenderPlan(videoTimeline("missing"), assets, () => "/tmp/x.bin"), (error) => {
    assert.equal(error.code, "MEDIA_INVALID_INPUT");
    assert.deepEqual(error.detail.issues.map((issue) => issue.code), ["clip.asset.missing"]);
    return true;
  });
  // 没有任何可视片段：源 renderPlan.ts 会渲染出黑屏"成功"，这里必须提前拒绝
  const noVisual = videoTimeline("a1", { tracks: [] });
  assert.throws(() => mediaDomain.compileRenderPlan(noVisual, assets, () => "/tmp/x.bin"), (error) => {
    assert.equal(error.code, "MEDIA_INVALID_INPUT");
    return true;
  });
  // 相对路径 / 控制字符必须拒绝（源 renderPlan.ts:27-30）
  assert.throws(() => mediaDomain.compileRenderPlan(videoTimeline("a1"), assets, () => "relative.mp4"), (error) => {
    assert.equal(error.code, "MEDIA_INVALID_INPUT");
    return true;
  });
});

// ── ③ buildFfmpegArgs ────────────────────────────────────────────────────
test("buildFfmpegArgs：黑底 + overlay + 音频 amix + MP4 输出（源 renderPlan.ts:82-126）", () => {
  const plan = {
    schemaVersion: "1.0", timelineVersion: 1, durationMs: 1000,
    canvas: { width: 160, height: 120, fps: 10 }, outputProfileId: "p",
    inputs: [
      { index: 0, clipId: "c1", assetId: "a1", path: "/tmp/media/a1.mp4", kind: "video", trackType: "video", timelineStartMs: 0, durationMs: 1000, sourceInMs: 0, sourceOutMs: 1000, volume: 1 },
      { index: 1, clipId: "c2", assetId: "a2", path: "/tmp/media/a2.m4a", kind: "audio", trackType: "music", timelineStartMs: 0, durationMs: 1000, sourceInMs: 0, sourceOutMs: 1000, volume: 0.5 },
    ],
  };
  const args = mediaDomain.buildFfmpegArgs(plan, "/tmp/media/out.mp4");
  const joined = args.join(" ");
  assert.ok(joined.includes("color=c=black:s=160x120:r=10:d=1.000[base]"));
  assert.ok(joined.includes("overlay=eof_action=pass:shortest=0[vover0]"));
  assert.ok(joined.includes("amix=inputs=1:duration=longest:normalize=0[aout]"));
  assert.ok(joined.includes("-c:v libx264"));
  assert.ok(joined.includes("-y /tmp/media/out.mp4"));
  assert.throws(() => mediaDomain.buildFfmpegArgs(plan, "/tmp/media/out.webm"), (error) => error.code === "MEDIA_INVALID_INPUT");
});

// ── ④ ffprobe 解析 ───────────────────────────────────────────────────────
test("parseFfprobeOutput：流选取 / 有理帧率 / 时长与大小（源 mediaProbe.ts:57-85）", () => {
  const raw = JSON.stringify({
    streams: [
      { codec_type: "audio", codec_name: "aac", channels: 1, sample_rate: "44100", duration: "1.010000" },
      { codec_type: "video", codec_name: "h264", width: 160, height: 120, avg_frame_rate: "30000/1001", r_frame_rate: "30/1" },
    ],
    format: { duration: "1.000000", size: "15302", format_name: "mov,mp4", bit_rate: "122416" },
  });
  const probe = mediaDomain.parseFfprobeOutput(raw);
  assert.equal(probe.durationMs, 1000);
  assert.equal(probe.sizeBytes, 15302);
  assert.equal(probe.hasVideo, true);
  assert.equal(probe.hasAudio, true);
  assert.equal(probe.width, 160);
  assert.equal(probe.fps, 29.97);
  assert.equal(probe.videoCodec, "h264");
  assert.equal(probe.audioCodec, "aac");
  assert.equal(probe.audioChannels, 1);
  assert.equal(probe.sampleRate, 44100);
  assert.throws(() => mediaDomain.parseFfprobeOutput("not json"), (error) => error.code === "MEDIA_PROBE_FAILED");
});

// ── ⑤ media/probe（真实样本经受监督 worker） ─────────────────────────────
test("media/probe：真实 ffmpeg 样本 → worker → 真实 ffprobe（离线）", async () => {
  const buffer = sampleBuffer();
  const fx = openBundle();
  const res = await fx.call("media/probe", { base64: buffer.toString("base64"), name: "sample.mp4", mime: "video/mp4" });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.probe.hasVideo, true);
  assert.equal(res.value.probe.hasAudio, true);
  assert.equal(res.value.probe.width, 160);
  assert.equal(res.value.probe.height, 120);
  assert.equal(res.value.probe.videoCodec, "h264");
  assert.equal(res.value.probe.formatName.startsWith("mov"), true);
  // 无绝对路径（源样本在 tempDir；IPC 出口只回相对/逻辑值）
  assert.equal(JSON.stringify(res).includes(fx.dir), false);
});

// ── ⑥ 封面缓存命中与失效 ─────────────────────────────────────────────────
test("封面缓存：命中不重跑 render，invalidate 后重跑（源 posterCache.ts:7-50）", async () => {
  const sourceDir = tempDir("dxos-media-poster-");
  const source = path.join(sourceDir, "movie.mp4");
  fs.writeFileSync(source, Buffer.alloc(64, 7));
  const cacheDir = path.join(sourceDir, "cache");
  let calls = 0;
  const cache = mediaStore.createVideoPosterCache(cacheDir, async (_source, target) => {
    calls += 1;
    await fs.promises.mkdir(cacheDir, { recursive: true });
    await fs.promises.writeFile(target, Buffer.from("jpeg-bytes"));
  });
  const first = await cache(source, 256);
  assert.equal(calls, 1);
  assert.equal(fs.statSync(first).size, Buffer.byteLength("jpeg-bytes"));
  const second = await cache(source, 256);
  assert.equal(second, first, "第二次必须命中同一个缓存文件");
  assert.equal(calls, 1, "命中不得重跑 render");
  assert.equal(await cache.invalidate(source, 256), true);
  const third = await cache(source, 256);
  assert.equal(third, first);
  assert.equal(calls, 2, "invalidate 后必须重新生成");
  assert.equal(await cache.invalidate(path.join(sourceDir, "nope.mp4"), 256), false);
});

test("media/poster/get：首次生成 cached:false、命中 cached:true、invalidate 后再生成 cached:false", async () => {
  const buffer = sampleBuffer();
  const fx = openBundle();
  const saved = await fx.call("media/asset/save", { projectId: PROJECT_ID, name: "poster.mp4", mime: "video/mp4", base64: buffer.toString("base64") });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  const assetId = saved.value.asset.id;
  const first = await fx.call("media/poster/get", { assetId, size: 640 });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.value.poster.cached, false, "首次生成必须 cached:false（不能恒 true）");
  const second = await fx.call("media/poster/get", { assetId, size: 640 });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.value.poster.cached, true, "缓存命中必须 cached:true");
  assert.equal(second.value.poster.fileName, first.value.poster.fileName);
  const invalidated = await fx.call("media/poster/invalidate", { assetId, size: 640 });
  assert.equal(invalidated.ok, true, JSON.stringify(invalidated));
  const third = await fx.call("media/poster/get", { assetId, size: 640 });
  assert.equal(third.ok, true, JSON.stringify(third));
  assert.equal(third.value.poster.cached, false, "invalidate 后重新生成必须 cached:false");
});

// ── ⑦ 租约过期回收 ───────────────────────────────────────────────────────
test("租约：claim → heartbeat → 过期回收为 interrupted → 再 claim", () => {
  const dir = tempDir("dxos-media-lease-");
  const store = new IdentityStore({ path: path.join(dir, "identity.db") }).open();
  openStores.push(store);
  const mediaDir = path.join(dir, "dxos", "media");
  let fakeNow = 1_000_000;
  mediaStore.configureMediaStore({ db: store.connection, mediaDir, clock: () => fakeNow });
  const projectId = mediaStore.ensureVideoProject({ id: PROJECT_ID, ownerId: "u-media", name: "租约项目" });
  assert.equal(projectId, PROJECT_ID);
  const asset = mediaStore.saveVideoAsset({ projectId, ownerId: "u-media", name: "a.mp4", mime: "video/mp4", buffer: Buffer.from("asset-bytes"), probe: { durationMs: 2000, hasVideo: true, hasAudio: false, width: 160, height: 120 } });
  assert.equal(typeof asset.relativePath, "string");
  assert.equal(asset.relativePath.includes(path.sep), false, "素材投影只回文件名，不回路径");

  const job = mediaStore.createVideoRenderJob({ projectId, ownerId: "u-media", timeline: videoTimeline(asset.id) });
  assert.equal(job.status, "queued");

  const claimed = mediaStore.claimNextVideoRenderJob("worker-A", 1000);
  assert.equal(claimed.id, job.id);
  assert.equal(claimed.status, "running");
  assert.equal(claimed.worker_id, "worker-A");
  assert.equal(claimed.lease_until, fakeNow + 1000);

  fakeNow += 500;
  assert.equal(mediaStore.heartbeatVideoRenderJob(job.id, "worker-A", 1000), true);
  assert.equal(mediaStore.heartbeatVideoRenderJob(job.id, "worker-B", 1000), false, "非持有者不得续租");
  assert.equal(mediaStore.heartbeatVideoRenderJob(job.id, "worker-A", 1000, 42), true);
  assert.equal(mediaStore.getVideoRenderJob(job.id).progress, 42);

  // 超过 lease_until 后才算过期：先把心跳续到 fakeNow+1000
  fakeNow += 1001;
  assert.equal(mediaStore.recoverExpiredVideoJobs(), 1, "租约过期必须回收");
  const interrupted = mediaStore.getVideoRenderJob(job.id);
  assert.equal(interrupted.status, "interrupted");
  assert.equal(interrupted.worker_id, null);
  assert.equal(interrupted.lease_until, null);

  fakeNow += 10;
  const again = mediaStore.claimNextVideoRenderJob("worker-B", 1000);
  assert.equal(again.id, job.id);
  assert.equal(again.worker_id, "worker-B");
  assert.equal(again.status, "running");
});

// ── ⑧ worker 失败 / 超时结构化错误 ───────────────────────────────────────
test("worker 失败：坏视频回 MEDIA_PROBE_FAILED、缺素材回 MEDIA_NOT_FOUND", async () => {
  const fx = openBundle();
  const bad = await fx.call("media/probe", { base64: Buffer.from("this is not a video").toString("base64"), name: "bad.mp4", mime: "video/mp4" });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, "MEDIA_PROBE_FAILED");
  assert.ok(bad.message.length > 0);

  const missing = await fx.call("media/probe", { assetId: "22222222-2222-4222-8222-222222222222" });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, "MEDIA_NOT_FOUND");

  const forbidden = await fx.call("media/probe", { filePath: "/etc/hosts" });
  assert.equal(forbidden.ok, false);
  assert.equal(forbidden.error, "MEDIA_FORBIDDEN");
});

test("worker 依赖缺失：二进制路径不存在回 MEDIA_DEPENDENCY_UNAVAILABLE，绝不假成功", async () => {
  const buffer = sampleBuffer();
  const fx = openBundle({ ffprobePath: "/nonexistent/dir/ffprobe-does-not-exist" });
  const res = await fx.call("media/probe", { base64: buffer.toString("base64"), name: "sample.mp4", mime: "video/mp4" });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.error, "MEDIA_DEPENDENCY_UNAVAILABLE");
  assert.equal(res.detail && res.detail.dependency, "ffprobe");
});

test("worker 超时：极小 timeoutMs 结构化回 MEDIA_TIMEOUT，不产生半截产物", async () => {
  const buffer = sampleBuffer();
  const fx = openBundle();
  const res = await fx.call("media/probe", { base64: buffer.toString("base64"), name: "sample.mp4", mime: "video/mp4", timeoutMs: 1 });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.error, "MEDIA_TIMEOUT");
  const tmpDir = path.join(fx.dxosMedia, "tmp");
  const leftovers = fs.existsSync(tmpDir) ? fs.readdirSync(tmpDir) : [];
  assert.deepEqual(leftovers, [], "超时后不得残留临时文件");
});

// ── ⑨ 渲染端到端（submit → run → get） ───────────────────────────────────
test("media/render/run：受监督子进程真实合成 → 成片落盘 → get 一致", async () => {
  const buffer = sampleBuffer();
  const fx = openBundle();
  const saved = await fx.call("media/asset/save", { projectId: PROJECT_ID, name: "a.mp4", mime: "video/mp4", base64: buffer.toString("base64") });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  const assetId = saved.value.asset.id;

  const submitted = await fx.call("media/render/submit", { projectId: PROJECT_ID, timeline: videoTimeline(assetId) });
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  assert.equal(submitted.value.job.status, "queued");
  const jobId = submitted.value.job.id;

  const ran = await fx.call("media/render/run", {});
  assert.equal(ran.ok, true, JSON.stringify(ran));
  assert.equal(ran.value.ran, true);
  assert.equal(ran.value.job.id, jobId);
  assert.equal(ran.value.job.status, "completed", JSON.stringify(ran.value.job));
  assert.equal(ran.value.job.progress, 100);
  assert.equal(ran.value.job.hasOutput, true);
  assert.match(ran.value.job.outputRelativePath, /^[0-9a-f-]+\.mp4$/);

  const fetched = await fx.call("media/render/get", { jobId });
  assert.equal(fetched.ok, true);
  assert.equal(fetched.value.job.status, "completed");
  assert.equal(JSON.stringify(fetched).includes(fx.dir), false, "渲染任务返回值不得含绝对路径");
  const outputFile = path.join(fx.dxosMedia, "renders", ran.value.job.outputRelativePath);
  assert.equal(fs.existsSync(outputFile), true, "成片必须真实落盘");

  const artifacts = await fx.call("media/artifact/list", {});
  assert.equal(artifacts.ok, true);
  const renders = artifacts.value.artifacts.filter((item) => item.kind === "render");
  assert.equal(renders.length, 1);
  assert.equal(renders[0].relativePath.startsWith("renders/"), true);
  assert.equal(JSON.stringify(artifacts).includes(fx.dir), false, "产物清单不得含绝对路径");

  // 队列已空：再跑一次返回 ran=false，不伪造任务
  const empty = await fx.call("media/render/run", {});
  assert.equal(empty.ok, true);
  assert.equal(empty.value.ran, false);
});
