/**
 * B5a · 媒体域纯逻辑（无 I/O）：命令白名单 + 风险/凭据属性 + 时间线校验 + 渲染计划 + ffprobe 解析 + 错误规约。
 *
 * 为什么单独一层：media:command 是本轮新增的顶层 IPC 通道，"哪些命令可被渲染层调用、
 * 每条命令的风险等级、是否触碰凭据、失败时回什么码"必须先在一处冻结，再交给
 * electron/media-service.cjs 分发、electron/media-bootstrap.cjs 注册。命令表本身即白名单：
 * 未登记的命令一律 MEDIA_COMMAND_NOT_ALLOWED，不做动态 dispatch。
 *
 * 时间线校验 / 渲染计划 / ffprobe 解析逐函数移植自只读源（行号为源文件行号）：
 *   · server/video/renderPlan.ts:27-30   safeAbsolutePath
 *   · server/video/renderPlan.ts:32-65   compileRenderPlan
 *   · server/video/renderPlan.ts:67-80   clipAllowedOnTrack / seconds / escapeSubtitlePath
 *   · server/video/renderPlan.ts:82-126  buildFfmpegArgs
 *   · server/video/mediaProbe.ts:44-55   finiteNumber / rational
 *   · server/video/mediaProbe.ts:57-85   parseFfprobeOutput
 *   · server/video/posterCache.ts:15     poster 缓存键（source + size/mtime/ctime + size + 'poster-v1'）
 *   · src/apps/video-editor/videoDomain.ts:104-153 validateTimeline
 *
 * 脱敏/错误规约复用 electron/dxos-foundation-errors.cjs 既有实现，保证 media 域的失败形状与
 * agent / skill / model / task 各域一致，不产生第二套错误协议。
 */
"use strict";

const { isAbsolute } = require("node:path");
const foundationErrors = require("./dxos-foundation-errors.cjs");
const { createHash } = require("node:crypto");

/** 下行事件通道：与 preload 的 media.onEvent / main.cjs 的 send 同名。 */
const MEDIA_EVENT_CHANNEL = "media:event";
const MEDIA_EVENT_DOMAIN = "media";

/** 时间线协议版本与源一致（videoDomain.ts:1）。 */
const MEDIA_TIMELINE_SCHEMA_VERSION = "1.0";

/** 媒体域自有错误码。与 DXOS_* / AGENT_* / SKILL_* 并列，不合并（域边界清晰，便于渲染层稳定判别）。 */
const MEDIA_ERR_COMMAND_NOT_ALLOWED = "MEDIA_COMMAND_NOT_ALLOWED";
const MEDIA_ERR_INVALID_INPUT = "MEDIA_INVALID_INPUT";
const MEDIA_ERR_UNAUTHENTICATED = "MEDIA_UNAUTHENTICATED";
const MEDIA_ERR_FORBIDDEN = "MEDIA_FORBIDDEN";
const MEDIA_ERR_NOT_FOUND = "MEDIA_NOT_FOUND";
const MEDIA_ERR_CONFLICT = "MEDIA_CONFLICT";
const MEDIA_ERR_DEPENDENCY_UNAVAILABLE = "MEDIA_DEPENDENCY_UNAVAILABLE";
const MEDIA_ERR_TIMEOUT = "MEDIA_TIMEOUT";
const MEDIA_ERR_CANCELLED = "MEDIA_CANCELLED";
const MEDIA_ERR_CHILD_FAILED = "MEDIA_CHILD_FAILED";
const MEDIA_ERR_PROBE_FAILED = "MEDIA_PROBE_FAILED";
const MEDIA_ERR_POSTER_FAILED = "MEDIA_POSTER_FAILED";
const MEDIA_ERR_RENDER_FAILED = "MEDIA_RENDER_FAILED";
const MEDIA_ERR_INTERNAL = "MEDIA_INTERNAL";

const MEDIA_ERROR_CODES = Object.freeze([
  MEDIA_ERR_COMMAND_NOT_ALLOWED,
  MEDIA_ERR_INVALID_INPUT,
  MEDIA_ERR_UNAUTHENTICATED,
  MEDIA_ERR_FORBIDDEN,
  MEDIA_ERR_NOT_FOUND,
  MEDIA_ERR_CONFLICT,
  MEDIA_ERR_DEPENDENCY_UNAVAILABLE,
  MEDIA_ERR_TIMEOUT,
  MEDIA_ERR_CANCELLED,
  MEDIA_ERR_CHILD_FAILED,
  MEDIA_ERR_PROBE_FAILED,
  MEDIA_ERR_POSTER_FAILED,
  MEDIA_ERR_RENDER_FAILED,
  MEDIA_ERR_INTERNAL,
]);

/**
 * media:command 白名单。
 *   risk       read | use | manage | destructive（与 skill-domain.cjs:77 同级定义）
 *   credential 该命令是否会把真实凭据带进执行路径（媒体域全部本地处理，恒为 false；
 *              字段保留是为了与其它域的命令表同形，且未来接入外部渲染时能显式标注）
 *   summary    中文一句话，供 UI（视频编辑器 / 媒体面板）与审计展示
 * 覆盖任务书要求的 command 族：渲染提交/查询/取消、探测（ffprobe）、封面缓存、租约心跳、产物落盘。
 */
const MEDIA_COMMANDS = Object.freeze({
  // ---- 项目 / 素材（media-store.cjs） ----
  "media/project/ensure": { risk: "manage", credential: false, summary: "创建或更新视频项目（所有权校验，不写他人项目）" },
  "media/asset/save": { risk: "manage", credential: false, summary: "保存媒体素材到 <userData>/dxos/media/assets 并记录探测元数据" },
  "media/asset/list": { risk: "read", credential: false, summary: "列出项目素材（不含磁盘绝对路径）" },
  "media/asset/delete": { risk: "destructive", credential: false, summary: "删除素材并清理落盘文件（有进行中渲染时拒绝）" },

  // ---- 探测 / 封面（受监督子进程） ----
  "media/probe": { risk: "read", credential: false, summary: "用 ffprobe 探测媒体时长 / 分辨率 / 编码（素材 / base64 二选一）" },
  "media/poster/get": { risk: "read", credential: false, summary: "生成或读取视频封面（按内容哈希缓存，命中不重跑 ffmpeg）" },
  "media/poster/invalidate": { risk: "manage", credential: false, summary: "失效某个视频的封面缓存（下次请求重新生成）" },

  // ---- 渲染作业（受监督子进程 + 租约） ----
  "media/render/submit": { risk: "manage", credential: false, summary: "提交视频渲染任务（编译渲染计划，入队等待执行）" },
  "media/render/get": { risk: "read", credential: false, summary: "查询单个渲染任务的状态 / 进度 / 结构化错误" },
  "media/render/list": { risk: "read", credential: false, summary: "列出渲染任务（按项目 / 状态过滤）" },
  "media/render/run": { risk: "use", credential: false, summary: "在受监督子进程中立即执行下一个排队任务并等待完成" },
  "media/render/cancel": { risk: "manage", credential: false, summary: "取消排队 / 运行 / 中断态的渲染任务" },
  "media/render/heartbeat": { risk: "manage", credential: false, summary: "续租渲染任务租约（workerId 不匹配即拒绝，返回 renewed=false）" },
  "media/render/recover": { risk: "manage", credential: false, summary: "回收租约过期的 running 任务（置为 interrupted，绝不伪造完成）" },

  // ---- 落盘产物 / 健康 ----
  "media/artifact/list": { risk: "read", credential: false, summary: "列出落盘产物（成片 / 封面 / 素材），只返回相对路径" },
  "media/health": { risk: "read", credential: false, summary: "媒体域依赖健康检查（ffmpeg / ffprobe / worker / 数据库）" },
});

/** 风险等级序（数值越大越危险）；UI 排序 / 审批阈值使用。 */
const RISK_LEVELS = Object.freeze({ read: 0, use: 1, manage: 2, destructive: 3 });

function isMediaCommand(command) {
  return typeof command === "string" && Object.prototype.hasOwnProperty.call(MEDIA_COMMANDS, command);
}

function mediaCommandEntry(command) {
  return isMediaCommand(command) ? MEDIA_COMMANDS[command] : null;
}

/** 未知命令返回 null（调用方据此判 MEDIA_COMMAND_NOT_ALLOWED，不猜风险）。 */
function mediaCommandRisk(command) {
  const entry = mediaCommandEntry(command);
  return entry ? entry.risk : null;
}

function mediaCommandRequiresCredential(command) {
  const entry = mediaCommandEntry(command);
  return !!(entry && entry.credential);
}

/**
 * 稳定顺序的命令清单（对象字面量声明顺序），供 UI 与测试消费。
 * 注意：IPC 投影把 credential 改名为 needsCredential —— dxos-foundation-errors.redactValue
 * 会把任何含 "credential" 的键当密钥字段掩码（dxos-foundation-mask.cjs:12），
 * 直接回 credential 布尔值会变成 "****alse" 这种掩码串。内部表仍叫 credential。
 */
function listMediaCommands() {
  return Object.keys(MEDIA_COMMANDS).map((command) => ({
    command,
    risk: MEDIA_COMMANDS[command].risk,
    needsCredential: MEDIA_COMMANDS[command].credential,
    summary: MEDIA_COMMANDS[command].summary,
  }));
}

/** 构造带稳定 code 的媒体域错误；message 过 foundation 的 redactText。 */
function createMediaError(code, message, detail) {
  const err = new Error(foundationErrors.redactText(message == null ? code : message));
  err.name = "MediaError";
  err.code = MEDIA_ERROR_CODES.includes(code) ? code : MEDIA_ERR_INTERNAL;
  err.detail = detail === undefined ? undefined : foundationErrors.redactValue(detail);
  return err;
}

function isMediaError(err) {
  return !!err && typeof err === "object" && typeof err.code === "string" && MEDIA_ERROR_CODES.includes(err.code);
}

/** 任意值与返回值脱敏：直接复用 foundation 的深度封顶 + 密钥字段掩码 + 绝对路径替换。 */
function redactMediaValue(value) {
  return foundationErrors.redactValue(value);
}

/**
 * 媒体域错误 → 渲染层安全结果。形状与 foundation 一致：{ ok:false, error, message, detail? }。
 */
function normalizeMediaError(err) {
  if (isMediaError(err)) {
    const out = { ok: false, error: err.code, message: foundationErrors.redactText(err.message || err.code) || err.code };
    if (err.detail !== undefined) out.detail = foundationErrors.redactValue(err.detail);
    return out;
  }
  return foundationErrors.normalizeError(err, { fallbackCode: foundationErrors.DXOS_ERR_INTERNAL });
}

function mediaCommandNotAllowed(command) {
  return createMediaError(MEDIA_ERR_COMMAND_NOT_ALLOWED, "未知或未授权的 media 命令：" + String(command == null ? "" : command), { command: command == null ? null : String(command) });
}

/** 渲染层出口：成功 { ok:true, value }；失败 normalizeMediaError（与 foundation.toIpcResult 同形）。 */
async function toMediaIpcResult(action) {
  try {
    const value = typeof action === "function" ? await action() : await action;
    return { ok: true, value: redactMediaValue(value) };
  } catch (err) {
    return normalizeMediaError(err);
  }
}

// ---------------------------------------------------------------------------
// 时间线校验（源 src/apps/video-editor/videoDomain.ts:104-153）
// ---------------------------------------------------------------------------

function finiteInteger(value) {
  return Number.isFinite(value) && Number.isInteger(value);
}

function issue(severity, code, message, extra) {
  return Object.assign({ severity, code, message }, extra || {});
}

/**
 * 源 validateTimeline(timeline) —— 逐条移植。
 * 与源唯一区别：入口先做形状防御（源假定调用方给的是合法对象；IPC 载荷来自渲染层，
 * 缺字段时必须回 MEDIA_INVALID_INPUT 而不是 TypeError）。
 */
function validateTimeline(timeline, assets) {
  const issues = [];
  if (!timeline || typeof timeline !== "object" || Array.isArray(timeline)) {
    return [issue("error", "timeline.invalid", "时间线必须是对象")];
  }
  if (!Array.isArray(timeline.tracks)) issues.push(issue("error", "tracks.invalid", "时间线 tracks 必须是数组"));
  const canvas = timeline.canvas && typeof timeline.canvas === "object" ? timeline.canvas : null;
  if (!canvas) issues.push(issue("error", "canvas.invalid", "画布尺寸必须是正整数"));
  const assetList = Array.isArray(assets) ? assets : [];
  const assetMap = new Map();
  for (const asset of assetList) if (asset && asset.id != null) assetMap.set(asset.id, asset);
  const assetIds = new Set(assetMap.keys());
  const trackIds = new Set();
  const clipIds = new Set();

  if (timeline.schemaVersion !== MEDIA_TIMELINE_SCHEMA_VERSION) {
    issues.push(issue("error", "schema.unsupported", "不支持的时间线协议：" + String(timeline.schemaVersion)));
  }
  if (timeline.timebase !== 1000) issues.push(issue("error", "timebase.invalid", "Timeline V1 必须使用 1000 毫秒时基"));
  if (!finiteInteger(timeline.durationMs) || timeline.durationMs < 0) issues.push(issue("error", "duration.invalid", "时间线总时长必须是非负整数毫秒"));
  if (canvas && (!finiteInteger(canvas.width) || !finiteInteger(canvas.height) || canvas.width <= 0 || canvas.height <= 0)) {
    issues.push(issue("error", "canvas.invalid", "画布尺寸必须是正整数"));
  }
  if (canvas && (!Number.isFinite(canvas.fps) || canvas.fps <= 0 || canvas.fps > 120)) {
    issues.push(issue("error", "fps.invalid", "帧率必须在 0–120 之间"));
  }

  for (const track of Array.isArray(timeline.tracks) ? timeline.tracks : []) {
    if (!track || typeof track !== "object") {
      issues.push(issue("error", "track.invalid", "轨道必须是对象"));
      continue;
    }
    if (trackIds.has(track.id)) issues.push(issue("error", "track.duplicate_id", "轨道 ID 重复：" + track.id, { trackId: track.id }));
    trackIds.add(track.id);
    const clips = Array.isArray(track.clips) ? track.clips : [];
    const sorted = [...clips].sort((a, b) => a.timelineStartMs - b.timelineStartMs);
    for (let index = 0; index < sorted.length; index += 1) {
      const clip = sorted[index];
      if (!clip || typeof clip !== "object") {
        issues.push(issue("error", "clip.invalid", "片段必须是对象", { trackId: track.id }));
        continue;
      }
      if (clipIds.has(clip.id)) issues.push(issue("error", "clip.duplicate_id", "片段 ID 重复：" + clip.id, { trackId: track.id, clipId: clip.id }));
      clipIds.add(clip.id);
      if (clip.trackId !== track.id) issues.push(issue("error", "clip.track_mismatch", "片段引用的轨道与所在轨道不一致", { trackId: track.id, clipId: clip.id }));
      if (!finiteInteger(clip.timelineStartMs) || clip.timelineStartMs < 0 || !finiteInteger(clip.durationMs) || clip.durationMs <= 0) {
        issues.push(issue("error", "clip.time.invalid", "片段起点和时长必须是有效整数毫秒", { trackId: track.id, clipId: clip.id }));
      }
      if (!finiteInteger(clip.sourceInMs) || !finiteInteger(clip.sourceOutMs) || clip.sourceInMs < 0 || clip.sourceOutMs <= clip.sourceInMs) {
        issues.push(issue("error", "clip.source.invalid", "片段源素材入点/出点无效", { trackId: track.id, clipId: clip.id }));
      }
      if (clip.assetId && !assetIds.has(clip.assetId)) issues.push(issue("error", "clip.asset.missing", "找不到片段素材：" + clip.name, { trackId: track.id, clipId: clip.id }));
      const asset = clip.assetId ? assetMap.get(clip.assetId) : undefined;
      if (asset && asset.durationMs && clip.sourceOutMs > asset.durationMs + 50) issues.push(issue("error", "clip.source.out_of_bounds", "片段源出点超出素材：" + clip.name, { trackId: track.id, clipId: clip.id }));
      if (clip.timelineStartMs + clip.durationMs > timeline.durationMs) issues.push(issue("error", "clip.out_of_bounds", "片段超出时间线：" + clip.name, { trackId: track.id, clipId: clip.id }));
      const previous = sorted[index - 1];
      if (previous && previous.timelineStartMs + previous.durationMs > clip.timelineStartMs && track.type !== "graphics") {
        issues.push(issue("warning", "clip.overlap", track.name + "存在重叠片段", { trackId: track.id, clipId: clip.id }));
      }
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// 渲染计划（源 server/video/renderPlan.ts）
// ---------------------------------------------------------------------------

/** 源 renderPlan.ts:27-30 */
function safeAbsolutePath(value) {
  if (!value || typeof value !== "string" || !isAbsolute(value) || /[\0\r\n]/.test(value)) {
    throw createMediaError(MEDIA_ERR_INVALID_INPUT, "渲染素材必须使用有效的绝对路径");
  }
  return value;
}

/** 源 renderPlan.ts:67-71 */
function clipAllowedOnTrack(_clip, track, asset) {
  if (track === "video" || track === "graphics") return asset === "video" || asset === "image";
  if (track === "voice" || track === "music") return asset === "audio" || asset === "video";
  return track === "subtitle" && asset === "subtitle";
}

/** 源 renderPlan.ts:73-75 */
function seconds(milliseconds) {
  return (milliseconds / 1000).toFixed(3);
}

/** 源 renderPlan.ts:77-80 */
function escapeSubtitlePath(path) {
  if (/[\0\r\n;\[\]]/.test(path)) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "字幕路径包含 FFmpeg 滤镜不允许的字符");
  return path.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'").replace(/,/g, "\\,");
}

/**
 * 源 renderPlan.ts:32-65 compileRenderPlan。
 * resolveAssetPath(asset) 由调用方给出（服务端从素材表取绝对路径，绝不信任渲染层给的 path）。
 */
function compileRenderPlan(timeline, assets, resolveAssetPath) {
  const errors = validateTimeline(timeline, assets).filter((entry) => entry.severity === "error");
  if (errors.length) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "Timeline 校验失败：" + errors.map((entry) => entry.code).join(", "), { issues: errors.map((entry) => ({ code: entry.code, message: entry.message })) });
  if (typeof resolveAssetPath !== "function") throw createMediaError(MEDIA_ERR_INVALID_INPUT, "compileRenderPlan 需要 resolveAssetPath");
  const assetMap = new Map((Array.isArray(assets) ? assets : []).map((asset) => [asset.id, asset]));
  const inputs = [];
  const supportedTracks = new Set(["video", "voice", "music", "subtitle", "graphics"]);
  for (const track of [...timeline.tracks].sort((a, b) => a.order - b.order)) {
    if (!supportedTracks.has(track.type) || track.hidden || (track.muted && (track.type === "voice" || track.type === "music"))) continue;
    for (const clip of [...(Array.isArray(track.clips) ? track.clips : [])].sort((a, b) => a.timelineStartMs - b.timelineStartMs)) {
      if (!clip.assetId) continue;
      const asset = assetMap.get(clip.assetId);
      if (!asset) throw createMediaError(MEDIA_ERR_NOT_FOUND, "缺少素材：" + clip.assetId);
      if (!clipAllowedOnTrack(clip, track.type, asset.kind)) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "素材 " + asset.name + " 与轨道 " + track.name + " 不兼容");
      if ((track.type === "voice" || track.type === "music") && asset.hasAudio === false) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "素材 " + asset.name + " 不含音轨");
      inputs.push({
        index: inputs.length,
        clipId: clip.id,
        assetId: asset.id,
        path: safeAbsolutePath(resolveAssetPath(asset)),
        kind: asset.kind,
        trackType: track.type,
        timelineStartMs: clip.timelineStartMs,
        durationMs: clip.durationMs,
        sourceInMs: clip.sourceInMs,
        sourceOutMs: clip.sourceOutMs,
        volume: Number.isFinite(clip.volume) ? clip.volume : 1,
      });
    }
  }
  if (!inputs.some((input) => input.trackType === "video" || input.trackType === "graphics")) {
    // 源 renderPlan.ts 没有这条：没有可视输入时 ffmpeg 的 overlay 链退化成纯黑底，
    // 渲染"成功"但成片是黑屏。这里提前拒绝，绝不产出一个看似成功的空片。
    throw createMediaError(MEDIA_ERR_INVALID_INPUT, "渲染计划没有任何可视片段（video / graphics 轨道为空）");
  }
  return {
    schemaVersion: "1.0",
    timelineVersion: timeline.version,
    durationMs: timeline.durationMs,
    canvas: { width: timeline.canvas.width, height: timeline.canvas.height, fps: timeline.canvas.fps },
    outputProfileId: timeline.outputProfileId,
    inputs,
  };
}

/** 源 renderPlan.ts:82-126 buildFfmpegArgs —— 输出路径固定由受监督 worker 决定。 */
function buildFfmpegArgs(plan, outputPath) {
  safeAbsolutePath(outputPath);
  if (!/\.mp4$/i.test(outputPath)) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "Phase 0 仅允许输出 MP4");
  const args = ["-hide_banner", "-loglevel", "warning"];
  for (const input of plan.inputs) {
    if (input.kind === "image") args.push("-loop", "1", "-t", seconds(input.durationMs));
    args.push("-i", input.path);
  }

  const filters = [];
  const width = plan.canvas.width;
  const height = plan.canvas.height;
  filters.push("color=c=black:s=" + width + "x" + height + ":r=" + plan.canvas.fps + ":d=" + seconds(plan.durationMs) + "[base]");
  const visuals = plan.inputs.filter((input) => (input.trackType === "video" || input.trackType === "graphics") && (input.kind === "video" || input.kind === "image"));
  let videoLabel = "base";
  visuals.forEach((input, index) => {
    const prepared = "vprep" + index;
    const overlaid = "vover" + index;
    const trim = input.kind === "image" ? "trim=duration=" + seconds(input.durationMs) : "trim=start=" + seconds(input.sourceInMs) + ":duration=" + seconds(input.durationMs);
    filters.push("[" + input.index + ":v:0]" + trim + ",setpts=PTS-STARTPTS+" + seconds(input.timelineStartMs) + "/TB,scale=" + width + ":" + height + ":force_original_aspect_ratio=decrease,pad=" + width + ":" + height + ":(ow-iw)/2:(oh-ih)/2:black,fps=" + plan.canvas.fps + "[" + prepared + "]");
    filters.push("[" + videoLabel + "][" + prepared + "]overlay=eof_action=pass:shortest=0[" + overlaid + "]");
    videoLabel = overlaid;
  });

  const subtitles = plan.inputs.filter((input) => input.trackType === "subtitle" && input.kind === "subtitle");
  if (subtitles.length > 1) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "Phase 0 每条时间线只支持一个字幕文件");
  if (subtitles[0]) {
    if (subtitles[0].timelineStartMs !== 0) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "Phase 0 字幕片段必须从时间线 0ms 开始");
    filters.push("[" + videoLabel + "]subtitles='" + escapeSubtitlePath(subtitles[0].path) + "'[vsub]");
    videoLabel = "vsub";
  }

  const audios = plan.inputs.filter((input) => (input.trackType === "voice" || input.trackType === "music") && (input.kind === "audio" || input.kind === "video"));
  const audioLabels = [];
  audios.forEach((input, index) => {
    const label = "aprep" + index;
    filters.push("[" + input.index + ":a:0]atrim=start=" + seconds(input.sourceInMs) + ":duration=" + seconds(input.durationMs) + ",asetpts=PTS-STARTPTS,adelay=delays=" + input.timelineStartMs + ":all=1,volume=" + input.volume.toFixed(3) + "[" + label + "]");
    audioLabels.push("[" + label + "]");
  });
  if (audioLabels.length) filters.push(audioLabels.join("") + "amix=inputs=" + audioLabels.length + ":duration=longest:normalize=0[aout]");

  args.push("-filter_complex", filters.join(";"), "-map", "[" + videoLabel + "]");
  if (audioLabels.length) args.push("-map", "[aout]", "-c:a", "aac", "-b:a", "192k");
  args.push("-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-r", String(plan.canvas.fps), "-t", seconds(plan.durationMs), "-movflags", "+faststart", "-y", outputPath);
  return args;
}

// ---------------------------------------------------------------------------
// ffprobe 解析（源 server/video/mediaProbe.ts）
// ---------------------------------------------------------------------------

/** 源 mediaProbe.ts:44-47 */
function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** 源 mediaProbe.ts:49-55 */
function rational(value) {
  if (!value || typeof value !== "string") return undefined;
  const [numerator, denominator] = value.split("/").map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return undefined;
  const result = numerator / denominator;
  return Number.isFinite(result) && result > 0 ? Math.round(result * 1000) / 1000 : undefined;
}

/** 源 mediaProbe.ts:57-85 parseFfprobeOutput */
function parseFfprobeOutput(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw createMediaError(MEDIA_ERR_PROBE_FAILED, "ffprobe 返回了无法解析的结果");
  }
  if (!parsed || typeof parsed !== "object") throw createMediaError(MEDIA_ERR_PROBE_FAILED, "ffprobe 返回了无法解析的结果");
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const video = streams.find((stream) => stream && stream.codec_type === "video");
  const audio = streams.find((stream) => stream && stream.codec_type === "audio");
  const formatDuration = finiteNumber(parsed.format && parsed.format.duration);
  const streamDuration = Math.max(0, ...streams.map((stream) => finiteNumber(stream && stream.duration) || 0));
  const duration = formatDuration !== undefined ? formatDuration : streamDuration;
  return {
    durationMs: Math.max(0, Math.round(duration * 1000)),
    sizeBytes: Math.max(0, Math.round(finiteNumber(parsed.format && parsed.format.size) || 0)),
    formatName: String((parsed.format && parsed.format.format_name) || ""),
    bitRate: finiteNumber(parsed.format && parsed.format.bit_rate),
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    width: video ? video.width : undefined,
    height: video ? video.height : undefined,
    fps: rational(video && video.avg_frame_rate) || rational(video && video.r_frame_rate),
    videoCodec: video ? video.codec_name : undefined,
    audioCodec: audio ? audio.codec_name : undefined,
    audioChannels: audio ? audio.channels : undefined,
    sampleRate: finiteNumber(audio && audio.sample_rate),
  };
}

// ---------------------------------------------------------------------------
// 封面缓存键（源 server/video/posterCache.ts:15）
// ---------------------------------------------------------------------------

/**
 * 源 posterCache.ts:15 的 key：source 绝对路径 + 文件 stat（size/mtime/ctime）+ 目标尺寸 + 'poster-v1'。
 * 注意：这个 key 只在主进程内部使用，绝不回渲染层；缓存文件名是 key 的 sha256，本身不含路径。
 */
function posterCacheKey(source, stat, size) {
  const info = stat && typeof stat === "object" ? stat : {};
  return createHash("sha256")
    .update(JSON.stringify([String(source || ""), info.size, info.mtimeMs, info.ctimeMs, size, "poster-v1"]))
    .digest("hex");
}

/** 允许的封面尺寸（源 posterCache.ts:13 size: 256 | 640）。 */
const MEDIA_POSTER_SIZES = Object.freeze([256, 640]);

module.exports = {
  MEDIA_EVENT_CHANNEL,
  MEDIA_EVENT_DOMAIN,
  MEDIA_TIMELINE_SCHEMA_VERSION,
  MEDIA_COMMANDS,
  MEDIA_ERROR_CODES,
  MEDIA_POSTER_SIZES,
  MEDIA_ERR_COMMAND_NOT_ALLOWED,
  MEDIA_ERR_INVALID_INPUT,
  MEDIA_ERR_UNAUTHENTICATED,
  MEDIA_ERR_FORBIDDEN,
  MEDIA_ERR_NOT_FOUND,
  MEDIA_ERR_CONFLICT,
  MEDIA_ERR_DEPENDENCY_UNAVAILABLE,
  MEDIA_ERR_TIMEOUT,
  MEDIA_ERR_CANCELLED,
  MEDIA_ERR_CHILD_FAILED,
  MEDIA_ERR_PROBE_FAILED,
  MEDIA_ERR_POSTER_FAILED,
  MEDIA_ERR_RENDER_FAILED,
  MEDIA_ERR_INTERNAL,
  RISK_LEVELS,
  isMediaCommand,
  mediaCommandEntry,
  mediaCommandRisk,
  mediaCommandRequiresCredential,
  listMediaCommands,
  createMediaError,
  isMediaError,
  redactMediaValue,
  normalizeMediaError,
  mediaCommandNotAllowed,
  toMediaIpcResult,
  finiteInteger,
  validateTimeline,
  compileRenderPlan,
  buildFfmpegArgs,
  safeAbsolutePath,
  parseFfprobeOutput,
  posterCacheKey,
};
