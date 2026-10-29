/**
 * 视频剪辑服务（10-15，「视频剪辑」应用用）：本机 FFmpeg 探测 / 拼接导出。
 *
 * 约束：
 *   · 渲染进程只给「条目引用 + 入出点」，磁盘路径由主进程经 file-service 解析，媒体信息由这里重新探测；
 *   · FFmpeg 只用固定参数模板（buildExportArgs，纯函数、可测），不接受任何渲染层拼的参数；
 *   · 同一时间只跑一个导出任务；可取消；输出先写系统临时目录，成功后再导入访达，失败不留半截文件。
 */
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");
const { bundledBinary } = require("./bundled-bin.cjs");

const CANDIDATE_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];
const RESOLUTIONS = { "1080p": [1920, 1080], "720p": [1280, 720], "480p": [854, 480] };
const MAX_CLIPS = 50;
const MAX_TOTAL_SEC = 2 * 3600;

function findBinary(name, env = process.env) {
  const dirs = [];
  if (env.OPENARC_FFMPEG_DIR) dirs.push(env.OPENARC_FFMPEG_DIR);
  else { const bundled = bundledBinary(name); if (bundled) return bundled; }
  dirs.push(...CANDIDATE_DIRS, ...String(env.PATH || "").split(path.delimiter).filter(Boolean));
  for (const d of dirs) {
    const p = path.join(d, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      /* 下一个 */
    }
  }
  return null;
}

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

/**
 * 纯函数：由已校验的片段生成 FFmpeg 参数。
 * clips: [{ path, start, end, hasAudio, width, height }]
 */
function buildExportArgs(clips, { resolution = "source", outPath }) {
  const [W, H] = RESOLUTIONS[resolution] || [even(clips[0].width || 1280), even(clips[0].height || 720)];
  const args = ["-hide_banner", "-nostdin", "-y"];
  clips.forEach((c) => {
    args.push("-ss", c.start.toFixed(3), "-t", (c.end - c.start).toFixed(3), "-i", c.path);
  });
  const parts = [];
  const labels = [];
  clips.forEach((c, i) => {
    const d = (c.end - c.start).toFixed(3);
    parts.push(`[${i}:v:0]setpts=PTS-STARTPTS,scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30,format=yuv420p[v${i}]`);
    if (c.hasAudio) parts.push(`[${i}:a:0]asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo[a${i}]`);
    else parts.push(`anullsrc=channel_layout=stereo:sample_rate=48000,atrim=0:${d}[a${i}]`);
    labels.push(`[v${i}][a${i}]`);
  });
  parts.push(`${labels.join("")}concat=n=${clips.length}:v=1:a=1[vout][aout]`);
  args.push(
    "-filter_complex", parts.join(";"),
    "-map", "[vout]", "-map", "[aout]",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    "-c:a", "aac", "-b:a", "160k",
    "-movflags", "+faststart",
    "-progress", "pipe:1", "-nostats",
    outPath,
  );
  return args;
}

function createVideoService({ env = process.env } = {}) {
  let job = null;

  function bins() {
    const ffmpeg = findBinary("ffmpeg", env);
    const ffprobe = ffmpeg ? path.join(path.dirname(ffmpeg), "ffprobe") : findBinary("ffprobe", env);
    return { ffmpeg, ffprobe: ffprobe && fs.existsSync(ffprobe) ? ffprobe : findBinary("ffprobe", env) };
  }

  function status() {
    const { ffmpeg, ffprobe } = bins();
    if (!ffmpeg || !ffprobe) return Promise.resolve({ ok: true, available: false });
    return new Promise((resolve) => {
      execFile(ffmpeg, ["-version"], { timeout: 5000 }, (err, out) => {
        if (err) return resolve({ ok: true, available: false });
        resolve({ ok: true, available: true, version: String(out).split("\n")[0].replace(/ Copyright.*/, "").slice(0, 60), busy: !!job });
      });
    });
  }

  function probePath(file) {
    const { ffprobe } = bins();
    if (!ffprobe) return Promise.resolve({ ok: false, error: "FFMPEG_MISSING" });
    return new Promise((resolve) => {
      execFile(ffprobe, ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file], { timeout: 15000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
        if (err) return resolve({ ok: false, error: "PROBE_FAILED" });
        try {
          const j = JSON.parse(String(out));
          const streams = Array.isArray(j.streams) ? j.streams : [];
          const v = streams.find((s) => s.codec_type === "video");
          const a = streams.find((s) => s.codec_type === "audio");
          const duration = Number(j.format && j.format.duration);
          if (!v || !Number.isFinite(duration) || duration <= 0) return resolve({ ok: false, error: "NOT_A_VIDEO" });
          resolve({ ok: true, duration, width: Number(v.width) || 0, height: Number(v.height) || 0, hasAudio: !!a });
        } catch {
          resolve({ ok: false, error: "PROBE_FAILED" });
        }
      });
    });
  }

  /**
   * clips: [{ path, start, end }]（路径已由主进程解析）。逐个重新探测并夹紧入出点。
   * onProgress(ratio 0..1)。返回 Promise<{ ok, outPath } | { ok:false, error }>。
   */
  async function exportClips(clipRefs, { resolution, name, onProgress }) {
    if (job) return { ok: false, error: "BUSY" };
    const { ffmpeg } = bins();
    if (!ffmpeg) return { ok: false, error: "FFMPEG_MISSING" };
    if (!Array.isArray(clipRefs) || !clipRefs.length || clipRefs.length > MAX_CLIPS) return { ok: false, error: "INVALID_INPUT" };
    const clips = [];
    for (const ref of clipRefs) {
      const info = await probePath(ref.path);
      if (!info.ok) return { ok: false, error: info.error };
      const start = Math.max(0, Math.min(Number(ref.start) || 0, info.duration));
      const end = Math.max(0, Math.min(Number.isFinite(Number(ref.end)) ? Number(ref.end) : info.duration, info.duration));
      if (end - start < 0.1) return { ok: false, error: "CLIP_TOO_SHORT" };
      clips.push({ path: ref.path, start, end, hasAudio: info.hasAudio, width: info.width, height: info.height });
    }
    const total = clips.reduce((s, c) => s + (c.end - c.start), 0);
    if (total > MAX_TOTAL_SEC) return { ok: false, error: "TOO_LONG" };
    const safeName = (String(name || "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "").trim().slice(0, 80) || "剪辑") + ".mp4";
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openarc-video-"));
    const outPath = path.join(dir, safeName);
    const args = buildExportArgs(clips, { resolution, outPath });
    return new Promise((resolve) => {
      const child = spawn(ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"] });
      let cancelled = false;
      let errTail = "";
      job = { cancel: () => { cancelled = true; child.kill("SIGKILL"); } };
      child.stdout.on("data", (buf) => {
        const m = /out_time_(?:us|ms)=(\d+)/g;
        let last = null;
        let r;
        while ((r = m.exec(String(buf)))) last = r[1];
        if (last !== null && onProgress) onProgress(Math.min(1, Number(last) / 1e6 / total));
      });
      child.stderr.on("data", (buf) => { errTail = (errTail + String(buf)).slice(-600); });
      child.on("close", (code) => {
        job = null;
        if (code === 0 && !cancelled && fs.existsSync(outPath)) return resolve({ ok: true, outPath, dir, duration: total });
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
        resolve({ ok: false, error: cancelled ? "CANCELLED" : "ENCODE_FAILED", detail: cancelled ? undefined : errTail.split("\n").filter(Boolean).slice(-2).join(" ").slice(0, 200) });
      });
      child.on("error", () => { job = null; resolve({ ok: false, error: "FFMPEG_MISSING" }); });
    });
  }

  function cancel() {
    if (!job) return { ok: false, error: "NO_JOB" };
    job.cancel();
    return { ok: true };
  }

  return { status, probePath, exportClips, cancel };
}

module.exports = { createVideoService, buildExportArgs, findBinary, RESOLUTIONS };
