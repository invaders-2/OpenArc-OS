/**
 * 视频智能切镜（TapNow Smart Clip）与「裁好直接进画布」。
 *
 * 契约（main process IPC）：
 *   media/detectScenes { dataUrl, threshold = 0.32, minGap = 0.8, maxCuts = 60 }
 *     成功 { ok: true, duration, cuts: number[], shots: [{ inSec, outSec }] }
 *     失败 { ok: false, error, detail? }   INVALID_INPUT / PROBE_FAILED / FFMPEG_MISSING / FFMPEG_TIMEOUT / FFMPEG_FAILED
 *   media/clipToCanvas { canvasId, dataUrl, segments: [{ inSec, outSec }], fileName? }
 *     每段用 clipVideo 裁出来，再经 canvasService.importAsset 存进资源库，临时文件随即删除。
 *     成功 { ok: true, clips: [{ ref, duration, inSec, outSec } | { error, detail? }] }
 *
 * 镜头检测用 ffmpeg 的 scene 分数（select='gt(scene,T)',showinfo），只读不写；
 * 切点之间距离小于 minGap 的合并，避免闪烁画面切出一堆零点几秒的碎片。
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { clipVideo, findFfmpeg, findFfprobe, probeDuration, runProcess, parseDataUrl } = require("./media-clip.cjs");

const SCENE_TIMEOUT_MS = 180000;
const MAX_SEGMENTS = 30;
const fail = (error, detail) => ({ ok: false, error, ...(detail === undefined ? {} : { detail }) });
const MIME_EXT = Object.freeze({ "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm", "video/x-matroska": "mkv" });

/** showinfo 输出里的 pts_time → 切点（秒），排序去重、按 minGap 合并、去掉贴着首尾的切点 */
function parseCuts(stderr, duration, minGap = 0.8, maxCuts = 60) {
  const raw = [];
  const re = /pts_time:\s*([0-9.]+)/g; let m;
  while ((m = re.exec(String(stderr || "")))) { const t = Number(m[1]); if (Number.isFinite(t)) raw.push(t); }
  raw.sort((a, b) => a - b);
  const cuts = [];
  for (const t of raw) {
    if (t < minGap || (duration && t > duration - minGap)) continue;
    if (cuts.length && t - cuts[cuts.length - 1] < minGap) continue;
    cuts.push(Math.round(t * 100) / 100);
    if (cuts.length >= maxCuts) break;
  }
  return cuts;
}
function shotsOf(cuts, duration) {
  const edges = [0, ...cuts, duration];
  const shots = [];
  for (let i = 0; i < edges.length - 1; i++) if (edges[i + 1] - edges[i] >= 0.2) shots.push({ inSec: edges[i], outSec: Math.round(edges[i + 1] * 100) / 100 });
  return shots;
}

async function detectScenes(input = {}, deps = {}) {
  const run = typeof deps.run === "function" ? deps.run : runProcess;
  const decoded = parseDataUrl(String(input.dataUrl || ""));
  if (!decoded || !/^video\//.test(decoded.mime)) return fail("INVALID_INPUT", "需要视频 data URL");
  const ffmpeg = findFfmpeg(input.ffmpegPath);
  if (!ffmpeg) return fail("FFMPEG_MISSING", "没有找到 ffmpeg（可用 OPENARC_FFMPEG 指定路径），无法检测镜头");
  const ffprobe = findFfprobe(input.ffprobePath, ffmpeg);
  const threshold = Math.min(0.9, Math.max(0.05, Number(input.threshold) || 0.32));
  const minGap = Math.min(10, Math.max(0.2, Number(input.minGap) || 0.8));
  const maxCuts = Math.min(200, Math.max(1, Math.trunc(Number(input.maxCuts) || 60)));
  const dir = fs.mkdtempSync(path.join(path.resolve(input.tmpDir || os.tmpdir()), "openarc-scenes-"));
  const file = path.join(dir, "input." + (MIME_EXT[decoded.mime] || "mp4"));
  try {
    fs.writeFileSync(file, decoded.buf, { mode: 0o600 });
    const duration = await probeDuration(ffmpeg, ffprobe, file, SCENE_TIMEOUT_MS);
    if (!duration) return fail("PROBE_FAILED", "读不出视频时长");
    const out = await run(ffmpeg, ["-hide_banner", "-nostats", "-i", file, "-an", "-filter:v", `select='gt(scene,${threshold})',showinfo`, "-f", "null", "-"], { timeoutMs: SCENE_TIMEOUT_MS });
    if (out.timedOut) return fail("FFMPEG_TIMEOUT", "镜头检测超时");
    if (out.code !== 0) return fail("FFMPEG_FAILED", String(out.stderr || "").slice(-400));
    const cuts = parseCuts(out.stderr, duration, minGap, maxCuts);
    return { ok: true, duration, cuts, shots: shotsOf(cuts, duration) };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/** 按段裁剪并存进资源库（canvasService.importAsset 负责画布编辑权限与容量上限） */
async function clipToCanvas(input = {}, { canvasService, context, clipImpl = clipVideo, tmpDir } = {}) {
  if (!canvasService || typeof canvasService.importAsset !== "function") return fail("RESOURCE_UNAVAILABLE");
  const dataUrl = String(input.dataUrl || "");
  if (!/^data:video\//i.test(dataUrl)) return fail("INVALID_INPUT", "需要视频 data URL");
  const segments = Array.isArray(input.segments) ? input.segments.slice(0, MAX_SEGMENTS) : [];
  if (!segments.length) return fail("INVALID_INPUT", "segments 为空");
  const name = String(input.fileName || "clip").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 80) || "clip";
  const clips = [];
  for (const seg of segments) {
    const inSec = Number(seg && seg.inSec); const outSec = Number(seg && seg.outSec);
    if (!Number.isFinite(inSec) || !Number.isFinite(outSec)) { clips.push({ error: "INVALID_RANGE" }); continue; }
    const r = await clipImpl({ dataUrl, inSec, outSec, format: "mp4", fileName: name, ...(tmpDir ? { tmpDir } : {}) });
    if (!r || !r.ok) { clips.push({ error: (r && r.error) || "CLIP_FAILED", ...(r && r.detail ? { detail: String(r.detail).slice(0, 300) } : {}) }); continue; }
    try {
      const bytes = fs.readFileSync(r.path);
      const imported = await canvasService.importAsset({ context, canvasId: String(input.canvasId || ""), name: `${name} ${Math.round(r.inSec * 10) / 10}s-${Math.round(r.outSec * 10) / 10}s.mp4`, dataUrl: "data:video/mp4;base64," + bytes.toString("base64") });
      if (imported && imported.ok && imported.ref) clips.push({ ref: imported.ref, duration: r.duration, inSec: r.inSec, outSec: r.outSec });
      else clips.push({ error: (imported && imported.error) || "IMPORT_FAILED" });
    } finally {
      try { fs.rmSync(r.path, { force: true }); } catch { /* ignore */ }
    }
  }
  return { ok: clips.some((c) => c.ref), clips, ...(clips.some((c) => c.ref) ? {} : { error: clips[0] && clips[0].error || "CLIP_FAILED" }) };
}

module.exports = { detectScenes, clipToCanvas, parseCuts, shotsOf, MAX_SEGMENTS };
