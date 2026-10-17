/**
 * B5a · 媒体受监督子进程（唯一重活执行入口）。
 *
 * 为什么单独一个子进程：ffmpeg / ffprobe 是外部原生程序，渲染可能持续数十秒并占满 CPU。
 * 按任务硬约束，重活不得阻塞主进程，必须走受监督子进程：本文件由 media-service.cjs 经
 * electron/dxos-foundation-runner.cjs（executor-launcher.cjs 的 Node / utilityProcess 两条实现）
 * 启动，超时 / 取消 / 输出上限 / 退出码全部由 runner 归一化。
 *
 * 与 electron/side-effect-executor.cjs 同一形态：stdout 只写本协议行，绝不回显 ffmpeg 原始输出。
 *   OPENARC_MEDIA_RESULT <json>     恰好一行，进程结束前的最终结果
 *   OPENARC_MEDIA_PROGRESS <json>   渲染过程中的进度行（可零到多行）
 *
 * 子进程自持 deadline：runner 用 SIGKILL 结束本进程时，ffmpeg 孙进程不会被自动带走。
 * 因此 spec.timeoutMs 会在本进程内提前 1s 触发（kill ffmpeg 后正常回结果），runner 的
 * timeoutMs 只作为更大的兜底 —— 这样超时不会留下孤儿 ffmpeg。
 *
 * 迁移来源（行号为只读源行号）：
 *   · server/video/mediaProbe.ts:87-122   ffprobe 参数 / stdout 上限 / 超时 / ENOENT 映射
 *   · server/video/posterCache.ts:52-73   ffmpeg 封面参数与超时
 *   · server/video/videoWorker.ts:15-55   ffmpeg 渲染参数 / -progress pipe:1 / 心跳无关部分
 *   · server/video/videoWorker.ts:68-72   渲染结果校验（hasVideo / 尺寸 / 时长 ±750ms）
 */
"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const mediaDomain = require("./media-domain.cjs");

const RESULT_PREFIX = "OPENARC_MEDIA_RESULT ";
const PROGRESS_PREFIX = "OPENARC_MEDIA_PROGRESS ";
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_SPEC_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120000;
/** 子进程自持 deadline 比 runner 提前的余量：保证 ffmpeg 被本进程亲手 kill。 */
const DEADLINE_MARGIN_MS = 1000;

function ffmpegCommand() {
  return String(process.env.FFMPEG_PATH || "ffmpeg").trim();
}
function ffprobeCommand() {
  return String(process.env.FFPROBE_PATH || "ffprobe").trim();
}

/** 统一结果出口：先 flush stdout 再退出，避免管道被 exit 截断。 */
function emitResult(payload) {
  const line = RESULT_PREFIX + JSON.stringify(payload) + "\n";
  let done = false;
  const finish = () => { if (done) return; done = true; process.exit(0); };
  try {
    process.stdout.write(line, finish);
  } catch {
    finish();
  }
  setTimeout(finish, 500).unref?.();
}

function emitProgress(payload) {
  try { process.stdout.write(PROGRESS_PREFIX + JSON.stringify(payload) + "\n"); } catch { /* 进度行丢失不改变渲染结果 */ }
}

/** spawn 失败（ENOENT / EACCES）→ 结构化依赖不可用，绝不假成功。 */
function dependencyOf(command) {
  return /ffprobe/i.test(command) ? "ffprobe" : "ffmpeg";
}

/**
 * 运行一个受本进程 deadline 约束的外部程序。
 * 返回 { ok, stdout, stderr, code } / { ok:false, timedOut } / { ok:false, dependency }。
 */
function runProcess(command, args, options) {
  const opts = options || {};
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? Math.max(0, opts.timeoutMs) : DEFAULT_TIMEOUT_MS;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ ok: false, dependency: dependencyOf(command), message: "无法启动 " + command + "：" + String((error && error.message) || error) });
      return;
    }
    let settled = false;
    let stdout = "";
    let stderr = "";
    let buffer = "";
    let timer = null;
    const done = (outcome) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(outcome);
    };
    child.on("error", (error) => {
      done({ ok: false, dependency: dependencyOf(command), message: "无法启动 " + command + "：" + String((error && error.message) || error) });
    });
    if (child.stdout) child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      stdout += text;
      if (stdout.length > MAX_STDOUT_BYTES) {
        try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
        done({ ok: false, message: "ffprobe 输出异常过大" });
        return;
      }
      if (typeof opts.onStdout === "function") {
        buffer += text;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";
        for (const line of lines) opts.onStdout(line);
      }
    });
    if (child.stderr) child.stderr.on("data", (chunk) => {
      stderr = (stderr + String(chunk)).slice(-16000);
      if (typeof opts.onStderr === "function") opts.onStderr(String(chunk));
    });
    child.on("close", (code) => {
      if (settled) return;
      done(code === 0 ? { ok: true, code: 0, stdout, stderr } : { ok: false, code: code == null ? null : code, stdout, stderr });
    });
    if (timeoutMs > 0) {
      const deadline = Math.max(0, timeoutMs - DEADLINE_MARGIN_MS);
      timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
        done({ ok: false, timedOut: true, message: "媒体子进程在 " + timeoutMs + "ms 内未完成" });
      }, deadline);
    }
  });
}

function errorResult(error, fallbackCode) {
  if (error && error.timedOut) return { ok: false, error: mediaDomain.MEDIA_ERR_TIMEOUT, message: error.message || "媒体操作超时" };
  if (error && error.dependency) return { ok: false, error: mediaDomain.MEDIA_ERR_DEPENDENCY_UNAVAILABLE, dependency: error.dependency, message: error.message || "媒体依赖不可用" };
  return { ok: false, error: fallbackCode || mediaDomain.MEDIA_ERR_INTERNAL, message: (error && error.message) || String(error) };
}

// ---------------------------------------------------------------------------
// op: probe（源 mediaProbe.ts:87-122）
// ---------------------------------------------------------------------------
async function opProbe(spec) {
  const filePath = String(spec.filePath || "");
  if (!filePath || !fs.existsSync(filePath)) return { ok: false, error: mediaDomain.MEDIA_ERR_NOT_FOUND, message: "待探测文件不存在" };
  const result = await runProcess(ffprobeCommand(), ["-v", "error", "-show_format", "-show_streams", "-of", "json", filePath], { timeoutMs: spec.timeoutMs });
  if (!result.ok) return errorResult(result, mediaDomain.MEDIA_ERR_PROBE_FAILED);
  try {
    return { ok: true, result: mediaDomain.parseFfprobeOutput(result.stdout) };
  } catch (error) {
    return { ok: false, error: (error && error.code) || mediaDomain.MEDIA_ERR_PROBE_FAILED, message: (error && error.message) || "ffprobe 解析失败" };
  }
}

// ---------------------------------------------------------------------------
// op: poster（源 posterCache.ts:52-73）
// ---------------------------------------------------------------------------
async function opPoster(spec) {
  const source = String(spec.source || "");
  const target = String(spec.target || "");
  const size = Number(spec.size);
  if (!source || !fs.existsSync(source)) return { ok: false, error: mediaDomain.MEDIA_ERR_NOT_FOUND, message: "封面源文件不存在" };
  if (!target) return { ok: false, error: mediaDomain.MEDIA_ERR_INVALID_INPUT, message: "封面目标路径为空" };
  const args = [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-threads", "1",
    "-protocol_whitelist", "file,pipe",
    "-format_whitelist", "mov,matroska,webm,avi,mpegts,mpeg,ogg,flv", "-i", source,
    "-map", "0:v:0", "-frames:v", "1", "-an",
    "-vf", "scale=" + size + ":" + size + ":force_original_aspect_ratio=decrease",
    "-threads", "1", "-q:v", "3", target,
  ];
  const result = await runProcess(ffmpegCommand(), args, { timeoutMs: spec.timeoutMs });
  if (!result.ok) return errorResult(result, mediaDomain.MEDIA_ERR_POSTER_FAILED);
  const stat = fs.existsSync(target) ? fs.statSync(target) : null;
  if (!stat || stat.size <= 0) return { ok: false, error: mediaDomain.MEDIA_ERR_POSTER_FAILED, message: "视频封面为空" };
  return { ok: true, result: { bytes: stat.size, size: size } };
}

// ---------------------------------------------------------------------------
// task-25 A21 · op: audio-extract / audio-trim（独立音频抽取/裁剪，不进渲染计划）
// ---------------------------------------------------------------------------
async function opAudio(spec) {
  const source = String(spec.source || "");
  const target = String(spec.target || "");
  if (!source || !fs.existsSync(source)) return { ok: false, error: mediaDomain.MEDIA_ERR_NOT_FOUND, message: "音频源文件不存在" };
  if (!target) return { ok: false, error: mediaDomain.MEDIA_ERR_INVALID_INPUT, message: "音频目标路径为空" };
  const startMs = spec.startMs == null ? null : Math.max(0, Math.round(Number(spec.startMs)));
  const durationMs = spec.durationMs == null ? null : Math.round(Number(spec.durationMs));
  if (startMs != null && !Number.isFinite(startMs)) return { ok: false, error: mediaDomain.MEDIA_ERR_INVALID_INPUT, message: "startMs 非法" };
  if (durationMs != null && (!Number.isFinite(durationMs) || durationMs < 100)) return { ok: false, error: mediaDomain.MEDIA_ERR_INVALID_INPUT, message: "durationMs 至少 100ms" };
  const args = [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-threads", "1",
    "-protocol_whitelist", "file,pipe",
    "-format_whitelist", "mov,matroska,webm,avi,mpegts,mpeg,ogg,flv,mp3,wav,aac,m4a",
  ];
  if (startMs) args.push("-ss", (startMs / 1000).toFixed(3));
  args.push("-i", source, "-map", "0:a:0", "-vn", "-c:a", "aac", "-b:a", "192k");
  if (durationMs != null) args.push("-t", (durationMs / 1000).toFixed(3));
  args.push(target);
  const result = await runProcess(ffmpegCommand(), args, { timeoutMs: spec.timeoutMs });
  if (!result.ok) return errorResult(result, mediaDomain.MEDIA_ERR_RENDER_FAILED);
  const stat = fs.existsSync(target) ? fs.statSync(target) : null;
  if (!stat || stat.size <= 0) return { ok: false, error: mediaDomain.MEDIA_ERR_RENDER_FAILED, message: "音频产物为空" };
  return { ok: true, result: { bytes: stat.size, startMs: startMs || 0, durationMs: durationMs == null ? null : durationMs } };
}

// ---------------------------------------------------------------------------
// op: render（源 videoWorker.ts:15-55 + :68-72）
// ---------------------------------------------------------------------------
async function opRender(spec) {
  const plan = spec.plan;
  const partialPath = String(spec.partialPath || "");
  if (!plan || !Array.isArray(plan.inputs)) return { ok: false, error: mediaDomain.MEDIA_ERR_INVALID_INPUT, message: "渲染计划缺失" };
  if (!partialPath) return { ok: false, error: mediaDomain.MEDIA_ERR_INVALID_INPUT, message: "渲染输出路径为空" };
  let args;
  try {
    args = mediaDomain.buildFfmpegArgs(plan, partialPath);
  } catch (error) {
    return { ok: false, error: (error && error.code) || mediaDomain.MEDIA_ERR_INVALID_INPUT, message: (error && error.message) || "渲染参数编译失败" };
  }
  // 源 videoWorker.ts:18 —— 在第 3 个位置插入 -progress pipe:1 -nostats，解析 out_time_us 报进度。
  args.splice(3, 0, "-progress", "pipe:1", "-nostats");
  const durationMs = Number(plan.durationMs) || 0;
  const result = await runProcess(ffmpegCommand(), args, {
    timeoutMs: spec.timeoutMs,
    onStdout: (line) => {
      const eq = line.indexOf("=");
      if (eq <= 0) return;
      const key = line.slice(0, eq);
      if (key !== "out_time_us") return;
      const outputMs = Number(line.slice(eq + 1)) / 1000;
      if (!Number.isFinite(outputMs)) return;
      const ratio = durationMs > 0 ? Math.max(0, Math.min(1, outputMs / durationMs)) : 0;
      // 源 videoWorker.ts:43 的 2 + ratio*94 只用于租约进度；worker 侧不碰数据库，只报观测值。
      emitProgress({ outTimeUs: Number(line.slice(eq + 1)), outTimeMs: outputMs, ratio: ratio });
    },
  });
  if (!result.ok) return errorResult(result, mediaDomain.MEDIA_ERR_RENDER_FAILED);
  // 源 videoWorker.ts:68-72 —— 渲染结果必须自证：有视频轨、尺寸与画布一致、时长误差 ≤ 750ms。
  const probe = await runProcess(ffprobeCommand(), ["-v", "error", "-show_format", "-show_streams", "-of", "json", partialPath], { timeoutMs: spec.timeoutMs });
  if (!probe.ok) return errorResult(probe, mediaDomain.MEDIA_ERR_PROBE_FAILED);
  let parsed;
  try {
    parsed = mediaDomain.parseFfprobeOutput(probe.stdout);
  } catch (error) {
    return { ok: false, error: mediaDomain.MEDIA_ERR_PROBE_FAILED, message: (error && error.message) || "成片探测失败" };
  }
  if (!parsed.hasVideo) return { ok: false, error: mediaDomain.MEDIA_ERR_RENDER_FAILED, message: "渲染结果缺少视频轨" };
  if (parsed.width !== plan.canvas.width || parsed.height !== plan.canvas.height) {
    return { ok: false, error: mediaDomain.MEDIA_ERR_RENDER_FAILED, message: "渲染尺寸错误：" + parsed.width + "×" + parsed.height };
  }
  if (Math.abs(parsed.durationMs - durationMs) > 750) {
    return { ok: false, error: mediaDomain.MEDIA_ERR_RENDER_FAILED, message: "渲染时长错误：" + parsed.durationMs + "ms" };
  }
  const stat = fs.existsSync(partialPath) ? fs.statSync(partialPath) : null;
  if (!stat || stat.size <= 0) return { ok: false, error: mediaDomain.MEDIA_ERR_RENDER_FAILED, message: "渲染成片为空" };
  return { ok: true, result: { outputPath: partialPath, bytes: stat.size, probe: parsed } };
}

// ---------------------------------------------------------------------------
// op: health
// ---------------------------------------------------------------------------
async function opHealth() {
  const ffmpeg = await runProcess(ffmpegCommand(), ["-version"], { timeoutMs: 10000 });
  const ffprobe = await runProcess(ffprobeCommand(), ["-version"], { timeoutMs: 10000 });
  const firstLine = (text) => String(text || "").split(/\r?\n/)[0] || null;
  return {
    ok: true,
    result: {
      ffmpeg: ffmpeg.ok ? firstLine(ffmpeg.stdout) : null,
      ffprobe: ffprobe.ok ? firstLine(ffprobe.stdout) : null,
      ffmpegError: ffmpeg.ok ? null : ffmpeg.dependency || "unavailable",
      ffprobeError: ffprobe.ok ? null : ffprobe.dependency || "unavailable",
      platform: process.platform,
    },
  };
}

const OPS = Object.freeze({ probe: opProbe, poster: opPoster, render: opRender, health: opHealth, "audio-extract": opAudio, "audio-trim": opAudio });

async function main() {
  const op = process.argv[2];
  const specPath = process.argv[3];
  if (!Object.prototype.hasOwnProperty.call(OPS, op)) {
    emitResult({ ok: false, error: mediaDomain.MEDIA_ERR_INVALID_INPUT, message: "未知媒体子进程操作：" + String(op) });
    return;
  }
  let spec = {};
  if (specPath) {
    try {
      const stat = fs.statSync(specPath);
      if (stat.size > MAX_SPEC_BYTES) {
        emitResult({ ok: false, error: mediaDomain.MEDIA_ERR_INVALID_INPUT, message: "媒体 spec 超过大小上限" });
        return;
      }
      spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
    } catch (error) {
      emitResult({ ok: false, error: mediaDomain.MEDIA_ERR_INVALID_INPUT, message: "媒体 worker 无法读取 spec：" + String((error && error.message) || error) });
      return;
    }
  }
  try {
    emitResult(await OPS[op](spec || {}));
  } catch (error) {
    emitResult({ ok: false, error: mediaDomain.MEDIA_ERR_INTERNAL, message: String((error && error.message) || error) });
  }
}

main();
