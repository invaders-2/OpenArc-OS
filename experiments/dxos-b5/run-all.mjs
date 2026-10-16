/**
 * B5a · 媒体域真实链路实验（离线）：ffmpeg 合成 → ffprobe 探测 → 封面缓存 → 渲染落盘。
 *
 * 全程走产品代码路径（electron/media-service.cjs 的 media 命令 + 受监督 video-render-worker.cjs），
 * 只在本机跑真实 ffmpeg / ffprobe，不联网、不调外部服务、不新增依赖。
 *
 * 产物保留在 artifacts/dxos-b5/<runId>/ 供人工复核；退出码 0 = 全部断言通过。
 *
 * 用法：node experiments/dxos-b5/run-all.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");

const { IdentityStore } = require(path.join(ROOT, "electron", "identity-store.cjs"));
const { createMediaBundle, DEFAULT_LEASE_MS } = require(path.join(ROOT, "electron", "media-service.cjs"));

const runId = "run-" + new Date().toISOString().replace(/[:.]/g, "-");
const OUT = path.join(ROOT, "artifacts", "dxos-b5", runId);
const USER_DATA = path.join(OUT, "userdata");
fs.mkdirSync(USER_DATA, { recursive: true });

const steps = [];
function step(name, detail) {
  steps.push({ name, detail });
  console.log("[B5] " + name + " · " + (typeof detail === "string" ? detail : JSON.stringify(detail)));
}

function ffmpeg(args) {
  execFileSync("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
}

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const ASSET_AUDIO = "22222222-2222-4222-8222-222222222222";

async function main() {
  const store = new IdentityStore({ path: path.join(USER_DATA, "identity.db") }).open();
  const authorization = {
    resolveActor({ context }) {
      return context && context.sessionRef ? { ok: true, user: { id: "u-b5a" } } : { ok: false, error: "no-session" };
    },
  };
  const bundle = createMediaBundle({ userDataDir: USER_DATA, identityStore: store, authorization: authorization });
  const call = (command, payload) => bundle.execute(command, payload || {}, { sessionRef: "sess-b5a", requestId: "exp-b5a" });
  const events = [];
  bundle.setEventSink((event) => events.push(event));

  try {
    // 0) 健康检查：确认 ffmpeg / ffprobe 可用（缺失会回 degraded）
    const health = await call("media/health", {});
    if (!health.ok) throw new Error("media/health 失败：" + JSON.stringify(health));
    step("health", { status: health.value.status, dependencies: health.value.dependencies, commands: health.value.commands, leaseMs: DEFAULT_LEASE_MS });
    if (health.value.status !== "ok") throw new Error("ffmpeg / ffprobe 不可用：" + JSON.stringify(health.value));

    // 1) ffmpeg 合成真实素材（160×120@10fps H.264 + AAC，1s）
    const sourceFile = path.join(OUT, "source.mp4");
    ffmpeg([
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc=size=160x120:rate=10:duration=1",
      "-f", "lavfi", "-i", "sine=frequency=660:duration=1",
      "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", sourceFile,
    ]);
    const sourceBuffer = fs.readFileSync(sourceFile);
    step("ffmpeg 合成", { file: path.relative(ROOT, sourceFile), bytes: sourceBuffer.length });

    // 2) ffprobe 探测（经受监督 worker）
    const probed = await call("media/probe", { base64: sourceBuffer.toString("base64"), name: "source.mp4", mime: "video/mp4" });
    if (!probed.ok) throw new Error("media/probe 失败：" + JSON.stringify(probed));
    step("ffprobe 探测", probed.value.probe);

    // 3) 保存素材（落 <userData>/dxos/media/assets）
    const saved = await call("media/asset/save", { projectId: PROJECT_ID, name: "source.mp4", mime: "video/mp4", base64: sourceBuffer.toString("base64") });
    if (!saved.ok) throw new Error("media/asset/save 失败：" + JSON.stringify(saved));
    const asset = saved.value.asset;
    step("素材落盘", { assetId: asset.id, relativePath: asset.relativePath, kind: asset.kind, durationMs: asset.durationMs, hasAudio: asset.hasAudio });

    // 4) 封面缓存（256 与 640 两档；第二次必须命中）
    const poster256 = await call("media/poster/get", { assetId: asset.id, size: 256 });
    if (!poster256.ok) throw new Error("media/poster/get(256) 失败：" + JSON.stringify(poster256));
    const poster256Again = await call("media/poster/get", { assetId: asset.id, size: 256 });
    const poster640 = await call("media/poster/get", { assetId: asset.id, size: 640 });
    if (!poster640.ok) throw new Error("media/poster/get(640) 失败：" + JSON.stringify(poster640));
    step("封面缓存", { size256: poster256.value.poster.fileName, bytes256: poster256.value.poster.bytes, idempotent: poster256Again.value.poster.fileName === poster256.value.poster.fileName, size640: poster640.value.poster.fileName });

    // 5) 渲染提交：视频轨 + 音乐轨（同一素材，验证 overlay + amix 链）
    const timeline = {
      schemaVersion: "1.0", projectId: PROJECT_ID, version: 1, timebase: 1000,
      canvas: { width: 160, height: 120, fps: 10 }, durationMs: 1000, outputProfileId: "b5a-default", updatedAt: Date.now(),
      tracks: [
        { id: "t-video", type: "video", name: "主画面", order: 0, locked: false, muted: false, hidden: false, clips: [{ id: "c-video", trackId: "t-video", assetId: asset.id, name: "画面", timelineStartMs: 0, durationMs: 1000, sourceInMs: 0, sourceOutMs: 1000, transform: {}, volume: 1 }] },
        { id: "t-music", type: "music", name: "音乐", order: 1, locked: false, muted: false, hidden: false, clips: [{ id: "c-music", trackId: "t-music", assetId: asset.id, name: "音乐", timelineStartMs: 0, durationMs: 1000, sourceInMs: 0, sourceOutMs: 1000, transform: {}, volume: 0.4 }] },
      ],
    };
    const submitted = await call("media/render/submit", { projectId: PROJECT_ID, timeline: timeline });
    if (!submitted.ok) throw new Error("media/render/submit 失败：" + JSON.stringify(submitted));
    const jobId = submitted.value.job.id;
    step("渲染提交", submitted.value.job);

    // 6) 渲染执行：受监督子进程真实合成 → 成片落盘
    const ran = await call("media/render/run", {});
    if (!ran.ok) throw new Error("media/render/run 失败：" + JSON.stringify(ran));
    if (!ran.value.ran || !ran.value.job || ran.value.job.status !== "completed") throw new Error("渲染未完成：" + JSON.stringify(ran.value));
    const outputAbs = path.join(USER_DATA, "dxos", "media", "renders", ran.value.job.outputRelativePath);
    if (!fs.existsSync(outputAbs)) throw new Error("成片未落盘：" + outputAbs);
    step("渲染完成", { jobId: jobId, status: ran.value.job.status, progress: ran.value.job.progress, relativePath: ran.value.job.outputRelativePath, bytes: fs.statSync(outputAbs).size });

    // 7) 对成片独立跑一次 ffprobe，确认真实尺寸 / 时长 / 编码
    const rawProbe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_format", "-show_streams", "-of", "json", outputAbs], { encoding: "utf8" }));
    const video = (rawProbe.streams || []).find((stream) => stream.codec_type === "video");
    const audio = (rawProbe.streams || []).find((stream) => stream.codec_type === "audio");
    const outDurationMs = Math.round(Number(rawProbe.format.duration) * 1000);
    if (!video || video.width !== 160 || video.height !== 120) throw new Error("成片尺寸错误：" + JSON.stringify(video));
    if (!audio) throw new Error("成片缺少音频轨（amix 链未生效）");
    if (Math.abs(outDurationMs - 1000) > 200) throw new Error("成片时长错误：" + outDurationMs);
    step("成片校验", { width: video.width, height: video.height, videoCodec: video.codec_name, audioCodec: audio.codec_name, durationMs: outDurationMs });

    // 8) 产物清单（只回相对路径）+ 事件信封
    const artifacts = await call("media/artifact/list", {});
    if (!artifacts.ok) throw new Error("media/artifact/list 失败：" + JSON.stringify(artifacts));
    if (JSON.stringify(artifacts).includes(USER_DATA)) throw new Error("产物清单泄漏了绝对路径");
    step("产物清单", artifacts.value.artifacts.map((item) => ({ kind: item.kind, relativePath: item.relativePath, bytes: item.bytes })));
    const lastEvent = events[events.length - 1];
    step("事件信封", { channel: lastEvent.channel, domain: lastEvent.domain, kind: lastEvent.kind, sequence: lastEvent.sequence, count: events.length });

    // 9) 复制成片 / 封面到实验目录，便于人工复核
    fs.copyFileSync(outputAbs, path.join(OUT, "render.mp4"));
    fs.copyFileSync(path.join(USER_DATA, "dxos", "media", "posters", poster640.value.poster.fileName), path.join(OUT, "poster-640.jpg"));
    fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify({ runId, ok: true, steps }, null, 2));

    console.log("[B5] 全部通过；产物目录：" + path.relative(ROOT, OUT));
    return 0;
  } finally {
    try { bundle.dispose(); } catch { /* 已停 */ }
    try { store.close(); } catch { /* 已关 */ }
  }
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error("[B5] FAILED · " + String((error && error.stack) || error));
  try { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify({ runId, ok: false, error: String((error && error.message) || error), steps }, null, 2)); } catch { /* 尽力保留 */ }
  process.exit(1);
});
