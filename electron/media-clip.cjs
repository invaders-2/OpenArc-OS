/**
 * 视频按「使用区间」裁剪（ffmpeg）。
 *
 * 契约（main process IPC 命令 media/clipVideo）：
 *   clipVideo({ srcPath | dataUrl, inSec, outSec, format = "mp4", fileName?, timeoutMs = 120000 })
 *   成功 { ok: true, path, bytes, duration, inSec, outSec, mode: "copy" | "reencode", fileName }
 *   失败 { ok: false, error, detail? }
 *     INVALID_INPUT / SOURCE_NOT_FOUND / INVALID_FORMAT / INVALID_RANGE / PROBE_FAILED
 *     FFMPEG_MISSING / FFMPEG_TIMEOUT / FFMPEG_FAILED / CLIP_FAILED
 *
 * 行为：
 *   · in/out 先 clamp 到 [0, 源时长]，并要求 out - in >= 0.2（否则 INVALID_RANGE）；
 *   · 先试 -ss/-to -c copy（关键帧不精确时输出时长会偏），用 ffprobe 校验；
 *     偏差超过 0.12s 或 copy 失败/空文件 → 退 -c:v libx264 -c:a aac 重编码；
 *   · 输出去临时目录（默认 os.tmpdir()/openarc-clips），重名自动 -1 / -2，绝不覆盖已有文件；
 *   · dataUrl 输入写临时文件，结束后清理（keepInput 可保留，测试用）；
 *   · 单次 ffmpeg 超时 120s，超时 SIGKILL 并清理半截输出；
 *   · 找不到 ffmpeg → { ok:false, error:"FFMPEG_MISSING" }，调用方必须优雅降级。
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { bundledBinary } = require("./bundled-bin.cjs");
const { spawn } = require("node:child_process");

const DEFAULT_TIMEOUT_MS = 120000;
const MIN_CLIP_SECONDS = 0.2;
const COPY_DURATION_TOLERANCE = 0.12;
const FORMATS = Object.freeze({ mp4: "mp4", mov: "mov" });
const MIME_EXT = Object.freeze({ "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm", "video/x-matroska": "mkv" });

const fail = (error, detail) => ({ ok: false, error, ...(detail === undefined ? {} : { detail }) });
const isFile = (file) => { try { return !!file && fs.statSync(file).isFile(); } catch { return false; } };
const numberOr = (value, fallback) => { const n = Number(value); return Number.isFinite(n) ? n : fallback; };

/** 显式路径优先；否则环境变量 → 常见安装位置 → PATH。显式路径不存在时按「没有 ffmpeg」处理。 */
function resolveTool(explicit, envKey, names, candidates) {
  const fromEnv = String(process.env[envKey] || "").trim();
  const explicitPath = String(explicit || "").trim();
  if (explicitPath) return isFile(explicitPath) ? explicitPath : null;
  if (fromEnv) return isFile(fromEnv) ? fromEnv : null;
  const bundled = bundledBinary(names[0]);
  if (bundled) return bundled;
  for (const candidate of candidates) if (isFile(candidate)) return candidate;
  for (const dir of String(process.env.PATH || "").split(":")) {
    if (!dir) continue;
    for (const name of names) { const candidate = path.join(dir, name); if (isFile(candidate)) return candidate; }
  }
  return null;
}

function findFfmpeg(explicit) {
  return resolveTool(explicit, "OPENARC_FFMPEG", ["ffmpeg"], ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"]);
}
function findFfprobe(explicit, ffmpeg) {
  const env = String(process.env.OPENARC_FFPROBE || "").trim();
  if (explicit) return isFile(String(explicit)) ? String(explicit) : null;
  if (env) return isFile(env) ? env : null;
  if (ffmpeg) { const sibling = path.join(path.dirname(ffmpeg), "ffprobe"); if (isFile(sibling)) return sibling; }
  return resolveTool(null, "OPENARC_FFPROBE", ["ffprobe"], ["/opt/homebrew/bin/ffprobe", "/usr/local/bin/ffprobe", "/usr/bin/ffprobe"]);
}

function runProcess(file, args, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"] }); }
    catch (error) { resolve({ code: -1, signal: null, stdout: "", stderr: String((error && error.message) || error), timedOut: false, spawnError: true }); return; }
    let stdout = ""; let stderr = ""; let timedOut = false; let settled = false;
    const finish = (code, signal, spawnError = false) => {
      if (settled) return; settled = true; clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut, ...(spawnError ? { spawnError: true } : {}) });
    };
    const timer = setTimeout(() => { timedOut = true; try { child.kill("SIGKILL"); } catch { /* already gone */ } }, Math.max(50, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => finish(-1, null, true));
    child.on("close", (code, signal) => finish(code, signal));
  });
}

/** 源/输出的时长（秒）。优先 ffprobe；没有 ffprobe 时从 ffmpeg -i 的 stderr 里抠。 */
async function probeDuration(ffmpeg, ffprobe, file, timeoutMs) {
  if (ffprobe) {
    const out = await runProcess(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file], { timeoutMs });
    const value = Number(String(out.stdout || "").trim());
    if (out.code === 0 && Number.isFinite(value) && value > 0) return value;
  }
  const out = await runProcess(ffmpeg, ["-hide_banner", "-i", file], { timeoutMs });
  const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(String(out.stderr || ""));
  if (!match) return null;
  const total = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  return Number.isFinite(total) && total > 0 ? total : null;
}

function parseDataUrl(value) {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/is.exec(String(value || ""));
  if (!match) return null;
  const mime = String(match[1] || "application/octet-stream").toLowerCase();
  let buf;
  try { buf = match[2] ? Buffer.from(match[3], "base64") : Buffer.from(decodeURIComponent(match[3])); } catch { return null; }
  return buf && buf.length ? { mime, buf } : null;
}

function safeStem(raw) {
  const text = String(raw == null ? "" : raw).split(/[\\/]/).pop() || "";
  const cleaned = text.replace(/\.[A-Za-z0-9]{1,5}$/, "").replace(/[\u0000-\u001f:*?"<>|]/g, "_").trim();
  return cleaned.slice(0, 100) || "clip";
}

/** 在 dir 里给 stem.ext 找不冲突的名字：name.ext → name-1.ext → …（绝不覆盖） */
function uniquePath(dir, stem, ext, exists = isFile) {
  let target = path.join(dir, stem + "." + ext);
  if (!exists(target)) return target;
  for (let i = 1; i <= 999; i += 1) {
    target = path.join(dir, stem + "-" + i + "." + ext);
    if (!exists(target)) return target;
  }
  return null;
}

function formatSeconds(value) {
  const rounded = Math.round(Number(value) * 100) / 100;
  return String(rounded).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

function cleanupFile(file) { try { if (file) fs.rmSync(file, { force: true }); } catch { /* ignore */ } }

/**
 * 裁剪。所有失败都是结构化返回值，不抛异常（IPC 边界更安全）。
 * @param {object} input
 * @param {object} [deps] 仅测试注入：{ run } 替换进程执行
 */
async function clipVideo(input = {}, deps = {}) {
  const options = input && typeof input === "object" ? input : {};
  const run = typeof deps.run === "function" ? deps.run : runProcess;
  const timeoutMs = Math.max(100, numberOr(options.timeoutMs, DEFAULT_TIMEOUT_MS));
  const format = String(options.format || "mp4").toLowerCase();
  const ext = FORMATS[format];
  if (!ext) return fail("INVALID_FORMAT", "只支持 mp4 / mov");

  const hasPath = typeof options.srcPath === "string" && options.srcPath.trim() !== "";
  const hasData = typeof options.dataUrl === "string" && options.dataUrl.trim() !== "";
  if (hasPath === hasData) return fail("INVALID_INPUT", "srcPath 与 dataUrl 必须二选一");
  if (options.inSec != null && !Number.isFinite(Number(options.inSec))) return fail("INVALID_INPUT", "inSec 不是数字");
  if (options.outSec != null && !Number.isFinite(Number(options.outSec))) return fail("INVALID_INPUT", "outSec 不是数字");

  const ffmpeg = findFfmpeg(options.ffmpegPath);
  if (!ffmpeg) return fail("FFMPEG_MISSING", "没有找到 ffmpeg（可用 OPENARC_FFMPEG 指定路径），无法按区间裁剪");
  const ffprobe = findFfprobe(options.ffprobePath, ffmpeg);

  let inputPath = "";
  let inputTmpDir = "";
  let outputPath = "";
  try {
    if (hasPath) {
      inputPath = path.resolve(String(options.srcPath).trim());
      if (!isFile(inputPath)) return fail("SOURCE_NOT_FOUND", "源视频不存在或不可读");
    } else {
      const decoded = parseDataUrl(String(options.dataUrl).trim());
      if (!decoded) return fail("INVALID_INPUT", "dataUrl 不是合法的 data URL");
      const mimeExt = MIME_EXT[decoded.mime] || ext;
      inputTmpDir = fs.mkdtempSync(path.join(path.resolve(options.tmpDir || os.tmpdir()), "openarc-clip-in-"));
      inputPath = path.join(inputTmpDir, "input." + mimeExt);
      fs.writeFileSync(inputPath, decoded.buf, { mode: 0o600 });
    }

    const sourceDuration = await probeDuration(ffmpeg, ffprobe, inputPath, timeoutMs);
    if (!sourceDuration) return fail("PROBE_FAILED", "读不出源视频时长（文件可能损坏或不是视频）");

    const start = Math.max(0, Math.min(sourceDuration, numberOr(options.inSec, 0)));
    const end = Math.max(0, Math.min(sourceDuration, numberOr(options.outSec, sourceDuration)));
    if (!(end - start >= MIN_CLIP_SECONDS)) return fail("INVALID_RANGE", "区间至少 0.2 秒（in < out - 0.2）");
    const want = end - start;

    const outDir = path.join(path.resolve(options.tmpDir || os.tmpdir()), "openarc-clips");
    fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
    const rangeTag = "-" + formatSeconds(start) + "s-" + formatSeconds(end) + "s";
    const stem = safeStem(options.fileName) + rangeTag;

    // 1) 先试流复制（快）；关键帧不精确时用 ffprobe 校验输出时长
    const copyPath = uniquePath(outDir, stem, ext);
    const copy = await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-ss", String(start), "-to", String(end), "-i", inputPath, "-c", "copy", "-avoid_negative_ts", "make_zero", copyPath], { timeoutMs });
    if (copy.timedOut) { cleanupFile(copyPath); return fail("FFMPEG_TIMEOUT", "裁剪超时（" + Math.round(timeoutMs / 1000) + "s）"); }
    let mode = "copy";
    if (copy.code === 0 && isFile(copyPath) && fs.statSync(copyPath).size > 0) {
      const actual = await probeDuration(ffmpeg, ffprobe, copyPath, timeoutMs);
      if (actual != null && Math.abs(actual - want) <= COPY_DURATION_TOLERANCE) {
        outputPath = copyPath;
        return { ok: true, path: outputPath, bytes: fs.statSync(outputPath).size, duration: actual, inSec: start, outSec: end, mode, fileName: path.basename(outputPath) };
      }
    }
    cleanupFile(copyPath); // copy 不精确 / 失败：删掉再重编码

    // 2) 重编码（精确到帧）
    const encodePath = uniquePath(outDir, stem, ext);
    const encode = await run(ffmpeg, [
      "-hide_banner", "-loglevel", "error",
      "-ss", String(start), "-to", String(end), "-i", inputPath,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
      "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", encodePath,
    ], { timeoutMs });
    if (encode.timedOut) { cleanupFile(encodePath); return fail("FFMPEG_TIMEOUT", "裁剪超时（" + Math.round(timeoutMs / 1000) + "s）"); }
    if (encode.code !== 0 || !isFile(encodePath) || !fs.statSync(encodePath).size) {
      cleanupFile(encodePath);
      return fail("FFMPEG_FAILED", String(encode.stderr || "ffmpeg 执行失败").slice(0, 500));
    }
    const finalDuration = (await probeDuration(ffmpeg, ffprobe, encodePath, timeoutMs)) || want;
    outputPath = encodePath;
    return { ok: true, path: outputPath, bytes: fs.statSync(outputPath).size, duration: finalDuration, inSec: start, outSec: end, mode: "reencode", fileName: path.basename(outputPath) };
  } catch (error) {
    cleanupFile(outputPath);
    return fail("CLIP_FAILED", String((error && error.message) || error).slice(0, 300));
  } finally {
    if (inputTmpDir && !options.keepInput) { try { fs.rmSync(inputTmpDir, { recursive: true, force: true }); } catch { /* ignore */ } }
  }
}

module.exports = { clipVideo, findFfmpeg, findFfprobe, probeDuration, runProcess, parseDataUrl, safeStem, uniquePath, DEFAULT_TIMEOUT_MS, COPY_DURATION_TOLERANCE, FORMATS };
