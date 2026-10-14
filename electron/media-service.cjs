/**
 * B5a · 媒体域装配 + media:command 分发（唯一执行入口）。
 *
 * 装配真实模块（不 mock、不新增依赖）：
 *   · media-store.cjs        电影项目 / 素材 / 渲染作业 + 封面缓存（configureMediaStore）
 *   · video-render-worker.cjs 受监督子进程：probe / poster / render / health
 *   · dxos-foundation-runner.cjs 超时 / 取消 / 输出上限 / 退出码归一化
 *   · dxos-foundation-events.cjs / dxos-foundation-errors.cjs 事件信封与脱敏
 *
 * 边界：
 *   · 渲染层自报的 userId / role / appId / sessionRef 一律忽略；actor 由 authorization.resolveActor
 *     从可信 sessionRef 推导（与 skill-service.cjs:216-225 同一条边界）。
 *   · <userData>/dxos/media 由 dxos-foundation-paths.cjs:18 统一登记；本文件不拼第二套路径。
 *   · 返回值统一过 media-domain.cjs 的 redactMediaValue —— 不含凭据、绝对值路径；
 *     所有投影只回相对文件名（硬约束："返回值不含绝对路径"）。
 *   · ffmpeg / ffprobe 未安装 → 子进程回 MEDIA_DEPENDENCY_UNAVAILABLE，本文件原样透出，
 *     绝不把"没跑成"包装成成功；sharp 只在探测图片素材时惰性 require，缺失同样结构化失败。
 *
 * 与源（server/video/videoWorker.ts）的差异：源 worker 在渲染循环里直接续租数据库租约；
 * 本实现把租约心跳放回**主进程**（worker 只回 progress 观测），并在租约丢失时取消子进程，
 * 因为数据库连接属于主进程，子进程不该持有它。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const { resolveDxosPaths, ensureDxosLayout } = require("./dxos-foundation-paths.cjs");
const { createSupervisedRunner } = require("./dxos-foundation-runner.cjs");
const { createEventChannel } = require("./dxos-foundation-events.cjs");

const mediaDomain = require("./media-domain.cjs");
const mediaStore = require("./media-store.cjs");
const foundationErrors = require("./dxos-foundation-errors.cjs");

const {
  createMediaError,
  normalizeMediaError,
  redactMediaValue,
  isMediaCommand,
  mediaCommandNotAllowed,
  listMediaCommands,
  MEDIA_ERR_INVALID_INPUT,
  MEDIA_ERR_UNAUTHENTICATED,
  MEDIA_ERR_NOT_FOUND,
  MEDIA_ERR_FORBIDDEN,
  MEDIA_ERR_CONFLICT,
  MEDIA_ERR_DEPENDENCY_UNAVAILABLE,
  MEDIA_ERR_TIMEOUT,
  MEDIA_ERR_CANCELLED,
  MEDIA_ERR_CHILD_FAILED,
  MEDIA_ERR_PROBE_FAILED,
  MEDIA_ERR_POSTER_FAILED,
  MEDIA_ERR_RENDER_FAILED,
  MEDIA_ERR_INTERNAL,
  MEDIA_EVENT_CHANNEL,
  MEDIA_POSTER_SIZES,
} = mediaDomain;

/** 媒体能力承载的 App Principal：与 skill-service.cjs:34 / agent-service.cjs:48 同一约定。 */
const HOST_APP_ID = "ai";

const RESULT_PREFIX = "OPENARC_MEDIA_RESULT ";
const PROGRESS_PREFIX = "OPENARC_MEDIA_PROGRESS ";

const DEFAULT_LEASE_MS = 30000;
const DEFAULT_WORKER_TIMEOUT_MS = 300000;
const DEFAULT_POSTER_TIMEOUT_MS = 60000;
const MAX_BASE64_BYTES = 256 * 1024 * 1024;
const MAX_ARTIFACTS = 500;
/** worker 自持 deadline 提前 runner 1s；这里给 runner 留 5s 余量，保证结构化结果先于 runner 兜底。 */
const RUNNER_MARGIN_MS = 5000;

const RENDER_STATUSES = Object.freeze(["queued", "running", "interrupted", "completed", "failed", "cancelled"]);

const asStr = (value, max = 512) => (typeof value === "string" ? value.slice(0, max) : value == null ? undefined : String(value).slice(0, max));
const requireStr = (value, max = 512) => { const text = asStr(value, max); return text && text.length ? text : null; };
const boundedTimeout = (value, fallback, max) => {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.round(value)));
};

/** 与 media-domain 的输入校验口径一致的 base64 解码（只认显式字段，不猜路径）。 */
function decodeBase64(payload, field) {
  const raw = payload[field] !== undefined ? payload[field] : payload.data !== undefined ? payload.data : payload.buffer;
  let buffer;
  if (Buffer.isBuffer(raw)) buffer = raw;
  else if (raw instanceof Uint8Array) buffer = Buffer.from(raw);
  else if (Array.isArray(raw) && raw.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)) buffer = Buffer.from(raw);
  else if (typeof raw === "string" && raw.length) {
    const base64 = raw.startsWith("data:") && raw.includes(",") ? raw.slice(raw.indexOf(",") + 1) : raw;
    buffer = Buffer.from(base64, "base64");
  } else {
    throw createMediaError(MEDIA_ERR_INVALID_INPUT, "需要媒体字节载荷（字段：base64 / data）");
  }
  if (!buffer.length) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "媒体载荷为空");
  if (buffer.length > MAX_BASE64_BYTES) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "媒体载荷超过 " + MAX_BASE64_BYTES + " 字节上限");
  return buffer;
}

function normalizePosterSize(value) {
  const size = Number(value);
  if (!MEDIA_POSTER_SIZES.includes(size)) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "封面尺寸只支持 " + MEDIA_POSTER_SIZES.join(" / "));
  return size;
}

/**
 * 解析外部二进制绝对路径。
 *
 * 为什么必需：executor-launcher.cjs:82 用**显式 env** spawn 子进程（只注入调用方给的键），
 * 子进程没有继承 PATH。若只按名字 spawn ffmpeg/ffprobe，worker 在受监督通道下必然 ENOENT
 * （实测：直接跑 worker 能成功、经 runner 就 MEDIA_DEPENDENCY_UNAVAILABLE）。因此这里在
 * 主进程把二进制解析成绝对路径，再经 spec.env 注入 worker；解析不到就是真的没装，
 * 交由 worker 回结构化的 MEDIA_DEPENDENCY_UNAVAILABLE。
 */
function resolveBinary(name, override) {
  // 显式配置优先（即使路径不存在）：错误配置必须由 worker 如实回依赖不可用，而不是偷偷换一个二进制。
  if (typeof override === "string" && override.length > 0) return override;
  const explicit = process.env[name === "ffmpeg" ? "FFMPEG_PATH" : "FFPROBE_PATH"];
  if (explicit) return explicit;
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  const dirs = String(process.env.PATH || "").split(path.delimiter).filter(Boolean)
    .concat(["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin", "/usr/bin", "/bin"]);
  for (const dir of new Set(dirs)) {
    for (const extension of extensions) {
      const candidate = path.join(dir, name + extension);
      try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* 继续找 */ }
    }
  }
  return null;
}

function createMediaBundle(options = {}) {
  const clock = typeof options.clock === "function" ? options.clock : () => Date.now();
  const logger = typeof options.logger === "function" ? options.logger : null;
  const userDataDir = options.userDataDir || null;
  const identityStore = options.identityStore || null;
  const authorization = options.authorization || null;
  const runner = options.runner && typeof options.runner.start === "function" ? options.runner : createSupervisedRunner({ clock: clock });
  const workerEntry = options.workerEntry || path.join(__dirname, "video-render-worker.cjs");
  const leaseMs = Number.isFinite(options.leaseMs) ? Math.max(1000, options.leaseMs) : DEFAULT_LEASE_MS;
  const workerTimeoutMs = Number.isFinite(options.workerTimeoutMs) ? options.workerTimeoutMs : DEFAULT_WORKER_TIMEOUT_MS;
  const posterTimeoutMs = Number.isFinite(options.posterTimeoutMs) ? options.posterTimeoutMs : DEFAULT_POSTER_TIMEOUT_MS;
  const ffmpegPath = resolveBinary("ffmpeg", options.ffmpegPath || null);
  const ffprobePath = resolveBinary("ffprobe", options.ffprobePath || null);
  /** worker 的显式 env：只注入解析到的二进制绝对路径（不注入 PATH，避免外部影响）。 */
  const workerEnv = {};
  if (ffmpegPath) workerEnv.FFMPEG_PATH = ffmpegPath;
  if (ffprobePath) workerEnv.FFPROBE_PATH = ffprobePath;

  const paths = userDataDir ? resolveDxosPaths(userDataDir) : null;
  const mediaDir = paths ? paths.directory.media : null;
  const db = identityStore ? identityStore.connection || identityStore.db || null : null;

  if (mediaDir) {
    try { fs.mkdirSync(mediaDir, { recursive: true }); } catch { /* 装配不阻断：具体命令再抛结构化落盘错误 */ }
    if (userDataDir) { try { ensureDxosLayout(userDataDir); } catch { /* 同上 */ } }
  }
  mediaStore.configureMediaStore({ db: db, mediaDir: mediaDir, clock: clock });

  const subDirs = mediaDir ? {
    assets: path.join(mediaDir, "assets"),
    renders: path.join(mediaDir, "renders"),
    posters: path.join(mediaDir, "posters"),
    tmp: path.join(mediaDir, "tmp"),
  } : null;

  function ensureDirs() {
    if (!subDirs) throw createMediaError(MEDIA_ERR_DEPENDENCY_UNAVAILABLE, "媒体目录未装配（缺少 userDataDir）", { dependency: "mediaDir" });
    for (const dir of Object.values(subDirs)) fs.mkdirSync(dir, { recursive: true });
    return subDirs;
  }

  // ---- 事件（P1 信封；bootstrap 的 send 经 setEventSink 注入） ----
  const channel = createEventChannel({ domain: mediaDomain.MEDIA_EVENT_DOMAIN, clock: clock });
  let eventSink = null;
  function setEventSink(fn) { eventSink = typeof fn === "function" ? fn : null; return true; }
  function emit(kind, payload) {
    const event = channel.emit(kind, payload);
    if (eventSink) { try { eventSink(event); } catch { /* 事件推送失败不改变业务结果 */ } }
    return event;
  }

  // -------------------------------------------------------------------------
  // 受监督子进程调用
  // -------------------------------------------------------------------------

  function writeSpecFile(spec) {
    const dirs = ensureDirs();
    const file = path.join(dirs.tmp, randomUUID() + ".json");
    fs.writeFileSync(file, JSON.stringify(spec), { mode: 0o600 });
    return file;
  }

  /**
   * 启动一次 worker 并等它 settle。
   * 返回 { runner, envelope }：envelope 是 worker 的 OPENARC_MEDIA_RESULT 或由 runner 事实归一的失败。
   */
  async function invokeWorker(op, spec, opts = {}) {
    const timeoutMs = boundedTimeout(opts.timeoutMs, workerTimeoutMs, 3600000);
    const specPath = writeSpecFile(spec === undefined ? {} : spec);
    let lastEnvelope = null;
    let buffer = "";
    const onEvent = (event) => {
      if (!event || event.type !== "stdout" || !event.text) return;
      buffer += event.text;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (line.startsWith(RESULT_PREFIX)) {
          try { lastEnvelope = JSON.parse(line.slice(RESULT_PREFIX.length)); } catch { lastEnvelope = null; }
        } else if (line.startsWith(PROGRESS_PREFIX)) {
          try {
            const progress = JSON.parse(line.slice(PROGRESS_PREFIX.length));
            if (typeof opts.onProgress === "function") opts.onProgress(progress);
          } catch { /* 单条进度行损坏不影响渲染结果 */ }
        }
      }
    };
    let handle = null;
    try {
      handle = runner.start({ entry: workerEntry, args: [op, specPath], env: workerEnv, timeoutMs: timeoutMs + RUNNER_MARGIN_MS, maxStdoutBytes: 8 * 1024 * 1024, onEvent });
      if (typeof opts.onHandle === "function") opts.onHandle(handle);
      const runnerResult = await handle.result;
      if (lastEnvelope) return { runner: runnerResult, envelope: lastEnvelope };
      if (runnerResult.timedOut) return { runner: runnerResult, envelope: { ok: false, error: MEDIA_ERR_TIMEOUT, message: "媒体子进程超时（" + timeoutMs + "ms）" } };
      if (runnerResult.cancelled) return { runner: runnerResult, envelope: { ok: false, error: MEDIA_ERR_CANCELLED, message: "媒体子进程已取消" } };
      return { runner: runnerResult, envelope: { ok: false, error: MEDIA_ERR_CHILD_FAILED, message: "媒体子进程未返回结构化结果（exit " + runnerResult.code + "）" } };
    } finally {
      try { fs.rmSync(specPath, { force: true }); } catch { /* 临时 spec 清理失败不改变结果 */ }
    }
  }

  /** 调用 worker；失败一律 throw 领域错误（绝不吞掉）。 */
  async function runWorker(op, spec, opts = {}) {
    const { envelope } = await invokeWorker(op, spec, opts);
    if (!envelope || envelope.ok !== true) {
      const code = envelope && typeof envelope.error === "string" ? envelope.error : MEDIA_ERR_CHILD_FAILED;
      const detail = envelope && envelope.dependency ? { dependency: envelope.dependency } : undefined;
      throw createMediaError(code, (envelope && envelope.message) || "媒体子进程失败", detail);
    }
    return envelope.result;
  }

  // -------------------------------------------------------------------------
  // 封面缓存（render 走受监督 worker）
  // -------------------------------------------------------------------------
  const posterCache = subDirs
    ? mediaStore.createVideoPosterCache(subDirs.posters, async (source, target, size) => {
        await runWorker("poster", { source: source, target: target, size: size, timeoutMs: posterTimeoutMs }, { timeoutMs: posterTimeoutMs });
      })
    : null;

  // -------------------------------------------------------------------------
  // 路径 / 素材解析
  // -------------------------------------------------------------------------

  /** 只允许媒体根内的绝对路径（渲染层拿不到路径；调用方一般是 assetId）。 */
  function assertWithinMediaRoot(value) {
    if (!mediaDir) throw createMediaError(MEDIA_ERR_DEPENDENCY_UNAVAILABLE, "媒体目录未装配", { dependency: "mediaDir" });
    const resolved = path.resolve(String(value || ""));
    const root = path.resolve(mediaDir) + path.sep;
    if (!resolved.startsWith(root)) throw createMediaError(MEDIA_ERR_FORBIDDEN, "只允许访问媒体目录内的文件");
    return resolved;
  }

  function sourcePathFor(payload, userId) {
    if (payload.assetId) return mediaStore.mediaAssetAbsolutePath(String(payload.assetId), userId);
    if (payload.filePath) return assertWithinMediaRoot(payload.filePath);
    return null;
  }

  /** 图片素材探测：只在需要时惰性 require sharp；缺失即结构化依赖不可用。 */
  async function probeImageBuffer(buffer, mime) {
    let sharp;
    try {
      sharp = require("sharp");
    } catch {
      throw createMediaError(MEDIA_ERR_DEPENDENCY_UNAVAILABLE, "sharp 未安装，无法探测图片素材", { dependency: "sharp" });
    }
    const metadata = await sharp(buffer, { failOn: "error" }).metadata();
    return { durationMs: 5000, sizeBytes: buffer.length, formatName: metadata.format || mime, hasVideo: true, hasAudio: false, width: metadata.width, height: metadata.height };
  }

  /** 探测素材：素材 / base64 / 媒体根内路径三选一（源 mediaProbe.ts:139-153 的语义）。 */
  async function probeAsset(payload, userId, timeoutMs) {
    const mime = String(payload.mime || "").toLowerCase();
    const name = String(payload.name || "");
    if (payload.base64 !== undefined || payload.data !== undefined || payload.buffer !== undefined) {
      const buffer = decodeBase64(payload, "base64");
      if (mime.startsWith("image/")) return probeImageBuffer(buffer, mime);
      if (/\.(srt|vtt)$/i.test(name)) {
        const preview = buffer.subarray(0, Math.min(buffer.length, 4096)).toString("utf8");
        if (!preview.trim()) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "字幕文件为空");
        return { durationMs: 0, sizeBytes: buffer.length, formatName: path.extname(name).slice(1), hasVideo: false, hasAudio: false };
      }
      const dirs = ensureDirs();
      const extension = /^\.[a-z0-9]{1,8}$/.test(path.extname(name).toLowerCase())
        ? path.extname(name).toLowerCase()
        : mime.startsWith("video/") ? ".mp4" : mime.startsWith("audio/") ? ".wav" : ".bin";
      const temp = path.join(dirs.tmp, randomUUID() + extension);
      fs.writeFileSync(temp, buffer, { flag: "wx" });
      try {
        return await runWorker("probe", { filePath: temp, timeoutMs: timeoutMs }, { timeoutMs: timeoutMs });
      } finally {
        try { fs.rmSync(temp, { force: true }); } catch { /* 清理失败不影响探测结果 */ }
      }
    }
    const sourcePath = sourcePathFor(payload, userId);
    if (!sourcePath) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "media/probe 需要 assetId / filePath / base64 之一");
    if (!fs.existsSync(sourcePath)) throw createMediaError(MEDIA_ERR_NOT_FOUND, "待探测文件不存在");
    return runWorker("probe", { filePath: sourcePath, timeoutMs: timeoutMs }, { timeoutMs: timeoutMs });
  }

  // -------------------------------------------------------------------------
  // 渲染作业执行（受监督子进程 + 主进程租约心跳）
  // -------------------------------------------------------------------------

  function cleanupPartial(partialPath) {
    try { if (partialPath && fs.existsSync(partialPath)) fs.rmSync(partialPath, { force: true }); } catch { /* 忽略 */ }
  }

  /**
   * 领取并执行一个排队 / 中断的渲染作业。
   * 返回 { ran, job }；worker 失败时作业置 failed（绝不写 completed），错误文本结构化落库。
   */
  async function runOneRenderJob(context) {
    const workerId = requireStr(context && context.workerId, 80) || "media-" + randomUUID();
    const claim = mediaStore.claimNextVideoRenderJob(workerId, leaseMs);
    if (!claim) return { ran: false, job: null };
    const jobId = claim.id;
    emit("progress", { command: "media/render/run", phase: "claimed", jobId: jobId, workerId: workerId });
    let timer = null;
    let handle = null;
    let leaseLost = false;
    let partialPath = "";
    try {
      const execution = mediaStore.renderJobExecutionData(claim, workerId);
      partialPath = execution.partialPath;
      const spec = { plan: execution.plan, partialPath: partialPath, timeoutMs: boundedTimeout(context && context.timeoutMs, workerTimeoutMs, 3600000) };
      timer = setInterval(() => {
        const renewed = mediaStore.heartbeatVideoRenderJob(jobId, workerId, leaseMs);
        if (!renewed) {
          leaseLost = true;
          if (handle && typeof handle.cancel === "function") handle.cancel("LEASE_LOST");
        }
      }, Math.max(1000, Math.floor(leaseMs / 3)));
      const { envelope } = await invokeWorker("render", spec, {
        timeoutMs: spec.timeoutMs,
        onHandle: (h) => { handle = h; },
        onProgress: (progress) => {
          if (timer && typeof progress.ratio === "number") {
            // 源 videoWorker.ts:43 的进度区间：2..96
            mediaStore.heartbeatVideoRenderJob(jobId, workerId, leaseMs, 2 + progress.ratio * 94);
          }
          emit("progress", { command: "media/render/run", phase: "render", jobId: jobId, ratio: progress.ratio });
        },
      });
      const current = mediaStore.getVideoRenderJob(jobId);
      if (!current || current.status !== "running" || current.worker_id !== workerId) {
        cleanupPartial(partialPath);
        return { ran: true, job: mediaStore.publicVideoRenderJob(mediaStore.getVideoRenderJob(jobId)), leaseLost: leaseLost };
      }
      if (!envelope || envelope.ok !== true) {
        const message = (envelope && envelope.message) || "渲染子进程失败";
        mediaStore.failVideoRenderJob(jobId, workerId, message);
        emit("progress", { command: "media/render/run", phase: "failed", jobId: jobId, error: (envelope && envelope.error) || MEDIA_ERR_RENDER_FAILED });
        cleanupPartial(partialPath);
        return { ran: true, job: mediaStore.publicVideoRenderJob(mediaStore.getVideoRenderJob(jobId)), error: envelope };
      }
      mediaStore.completeVideoRenderJob(jobId, workerId, partialPath);
      emit("progress", { command: "media/render/run", phase: "completed", jobId: jobId });
      return { ran: true, job: mediaStore.publicVideoRenderJob(mediaStore.getVideoRenderJob(jobId)) };
    } catch (error) {
      cleanupPartial(partialPath);
      const current = mediaStore.getVideoRenderJob(jobId);
      if (current && current.status === "running" && current.worker_id === workerId) {
        mediaStore.failVideoRenderJob(jobId, workerId, (error && error.message) || String(error));
      }
      throw error;
    } finally {
      if (timer) clearInterval(timer);
    }
  }

  // -------------------------------------------------------------------------
  // 产物清单（只回相对路径）
  // -------------------------------------------------------------------------
  function listArtifacts() {
    if (!subDirs) return [];
    const out = [];
    const groups = [["asset", subDirs.assets], ["render", subDirs.renders], ["poster", subDirs.posters]];
    for (const [kind, dir] of groups) {
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir)) {
        if (kind === "render" && name.includes(".partial.")) continue;
        const full = path.join(dir, name);
        let stat;
        try { stat = fs.statSync(full); } catch { continue; }
        if (!stat.isFile()) continue;
        out.push({ kind: kind, id: kind === "poster" ? path.basename(name, path.extname(name)) : name, fileName: name, relativePath: kind + "s/" + name, bytes: stat.size, mtime: stat.mtimeMs });
      }
    }
    return out.sort((a, b) => b.mtime - a.mtime).slice(0, MAX_ARTIFACTS);
  }

  // -------------------------------------------------------------------------
  // 命令分发
  // -------------------------------------------------------------------------

  async function ensureProject(payload, userId) {
    const projectId = requireStr(payload.projectId, 80);
    if (!projectId) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "projectId 必填");
    return mediaStore.ensureVideoProject({ id: projectId, ownerId: userId, name: requireStr(payload.projectName, 120) || undefined });
  }

  async function dispatch(command, payload, context) {
    const userId = context.userId;
    switch (command) {
      // ---------------- 项目 / 素材 ----------------
      case "media/project/ensure": {
        const projectId = await ensureProject(payload, userId);
        return { projectId: projectId };
      }
      case "media/asset/save": {
        const projectId = requireStr(payload.projectId, 80);
        if (!projectId) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "projectId 必填");
        const name = requireStr(payload.name, 255);
        if (!name) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "素材 name 必填");
        const mime = requireStr(payload.mime, 120) || "application/octet-stream";
        const buffer = decodeBase64(payload, "base64");
        const timeoutMs = boundedTimeout(payload.timeoutMs, workerTimeoutMs, 3600000);
        const probe = await probeAsset({ base64: buffer, name: name, mime: mime, timeoutMs: timeoutMs }, userId, timeoutMs);
        const asset = mediaStore.saveVideoAsset({ projectId: projectId, ownerId: userId, projectName: requireStr(payload.projectName, 120) || undefined, name: name, mime: mime, buffer: buffer, probe: probe });
        return { asset: asset };
      }
      case "media/asset/list": {
        const projectId = requireStr(payload.projectId, 80);
        if (!projectId) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "projectId 必填");
        return { assets: mediaStore.listVideoAssetRows(projectId, userId).map(mediaStore.videoAssetView) };
      }
      case "media/asset/delete": {
        const id = requireStr(payload.assetId, 80) || requireStr(payload.id, 80);
        if (!id) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "assetId 必填");
        return { deleted: mediaStore.deleteVideoAsset(id, userId) };
      }

      // ---------------- 探测 / 封面 ----------------
      case "media/probe": {
        const timeoutMs = boundedTimeout(payload.timeoutMs, workerTimeoutMs, 3600000);
        return { probe: await probeAsset(payload, userId, timeoutMs) };
      }
      case "media/poster/get": {
        const size = normalizePosterSize(payload.size === undefined ? 640 : payload.size);
        const source = sourcePathFor(payload, userId);
        if (!source) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "media/poster/get 需要 assetId 或 filePath");
        if (!fs.existsSync(source)) throw createMediaError(MEDIA_ERR_NOT_FOUND, "封面源文件不存在");
        if (!posterCache) throw createMediaError(MEDIA_ERR_DEPENDENCY_UNAVAILABLE, "封面缓存未装配", { dependency: "mediaDir" });
        const target = await posterCache(source, size);
        const stat = fs.statSync(target);
        return { poster: { id: path.basename(target, ".jpg"), fileName: path.basename(target), size: size, bytes: stat.size, cached: true } };
      }
      case "media/poster/invalidate": {
        const size = normalizePosterSize(payload.size === undefined ? 640 : payload.size);
        const source = sourcePathFor(payload, userId);
        if (!source) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "media/poster/invalidate 需要 assetId 或 filePath");
        if (!posterCache) throw createMediaError(MEDIA_ERR_DEPENDENCY_UNAVAILABLE, "封面缓存未装配", { dependency: "mediaDir" });
        return { invalidated: await posterCache.invalidate(source, size) };
      }

      // ---------------- 渲染作业 ----------------
      case "media/render/submit": {
        const projectId = requireStr(payload.projectId, 80);
        if (!projectId) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "projectId 必填");
        const job = mediaStore.createVideoRenderJob({ projectId: projectId, ownerId: userId, projectName: requireStr(payload.projectName, 120) || undefined, timeline: payload.timeline });
        emit("progress", { command: command, phase: "queued", jobId: job.id });
        return { job: mediaStore.publicVideoRenderJob(job) };
      }
      case "media/render/get": {
        const id = requireStr(payload.jobId, 80) || requireStr(payload.id, 80);
        if (!id) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "jobId 必填");
        const job = mediaStore.getVideoRenderJob(id, userId);
        if (!job) throw createMediaError(MEDIA_ERR_NOT_FOUND, "渲染任务不存在");
        return { job: mediaStore.publicVideoRenderJob(job) };
      }
      case "media/render/list": {
        const statuses = Array.isArray(payload.statuses) ? payload.statuses.filter((s) => RENDER_STATUSES.includes(s)) : [];
        const jobs = mediaStore.listVideoRenderJobs({ ownerId: userId, projectId: requireStr(payload.projectId, 80) || undefined, statuses: statuses, limit: payload.limit });
        return { jobs: jobs.map(mediaStore.publicVideoRenderJob) };
      }
      case "media/render/run": {
        const workerId = requireStr(payload.workerId, 80);
        if (payload.workerId !== undefined && !/^[A-Za-z0-9_-]{1,80}$/.test(String(payload.workerId))) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "workerId 形态非法");
        const result = await runOneRenderJob({ userId: userId, workerId: workerId, timeoutMs: payload.timeoutMs });
        return result;
      }
      case "media/render/cancel": {
        const id = requireStr(payload.jobId, 80) || requireStr(payload.id, 80);
        if (!id) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "jobId 必填");
        const job = mediaStore.cancelVideoRenderJob(id, userId);
        emit("progress", { command: command, phase: "cancelled", jobId: id });
        return { job: mediaStore.publicVideoRenderJob(job) };
      }
      case "media/render/heartbeat": {
        const id = requireStr(payload.jobId, 80) || requireStr(payload.id, 80);
        const workerId = requireStr(payload.workerId, 80);
        if (!id || !workerId) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "heartbeat 需要 jobId 与 workerId");
        const renewed = mediaStore.heartbeatVideoRenderJob(id, workerId, leaseMs, payload.progress);
        return { jobId: id, renewed: renewed };
      }
      case "media/render/recover": {
        return { recovered: mediaStore.recoverExpiredVideoJobs() };
      }

      // ---------------- 产物 / 健康 ----------------
      case "media/artifact/list": {
        return { artifacts: listArtifacts() };
      }
      case "media/health": {
        let ffmpeg = null;
        let ffprobe = null;
        let workerReachable = false;
        try {
          const health = await runWorker("health", {}, { timeoutMs: 30000 });
          ffmpeg = health ? health.ffmpeg || null : null;
          ffprobe = health ? health.ffprobe || null : null;
          workerReachable = true;
        } catch { workerReachable = false; }
        const dependencies = {
          database: !!db,
          mediaDirectory: !!mediaDir,
          identity: !!authorization,
          worker: workerReachable,
          // 键名避开 isSecretKey 的子串（dxos-foundation-mask.cjs:12）
          ffmpegBinary: !!ffmpeg,
          ffprobeBinary: !!ffprobe,
        };
        const ok = dependencies.database && dependencies.mediaDirectory && workerReachable && dependencies.ffmpegBinary && dependencies.ffprobeBinary;
        return { status: ok ? "ok" : "degraded", dependencies: dependencies, ffmpeg: ffmpeg, ffprobe: ffprobe, commands: listMediaCommands().length, eventChannel: MEDIA_EVENT_CHANNEL, leaseMs: leaseMs };
      }

      default:
        throw mediaCommandNotAllowed(command);
    }
  }

  /** sessionRef → actor；不可解析时返回 { ok:false }，绝不伪造身份。 */
  function resolveActor(context) {
    if (!authorization || typeof authorization.resolveActor !== "function") return { ok: false, message: "授权服务未装配" };
    try {
      const result = authorization.resolveActor({ context: context });
      if (!result || result.ok !== true || !result.user || result.user.id == null) return { ok: false, message: (result && (result.error || result.reason)) || "会话无效" };
      return result;
    } catch (error) {
      return { ok: false, message: String((error && error.message) || error) };
    }
  }

  /**
   * 唯一分发入口：白名单 → actor 解析 → dispatch → 脱敏；失败统一 normalizeMediaError。
   * 每次执行前后各发一条 progress 事件（P1 信封），供渲染层显示与丢帧判定。
   */
  async function execute(command, payload, ctx = {}) {
    if (!isMediaCommand(command)) return normalizeMediaError(mediaCommandNotAllowed(command));
    const context = {
      sessionRef: requireStr(ctx && ctx.sessionRef, 160) || null,
      appId: requireStr(ctx && ctx.appId, 60) || HOST_APP_ID,
      source: "media",
      requestId: requireStr(ctx && ctx.requestId, 100) || null,
    };
    emit("progress", { command: command, phase: "begin", requestId: context.requestId });
    const actorResult = resolveActor(context);
    if (!actorResult.ok) {
      emit("progress", { command: command, phase: "rejected", reason: "unauthenticated", requestId: context.requestId });
      return normalizeMediaError(createMediaError(MEDIA_ERR_UNAUTHENTICATED, actorResult.message || "当前会话未认证，media 命令被拒绝"));
    }
    context.userId = String(actorResult.user.id);
    context.actor = actorResult.user;
    const body = payload && typeof payload === "object" ? payload : {};
    try {
      const value = await dispatch(command, body, context);
      emit("progress", { command: command, phase: "completed", requestId: context.requestId });
      return { ok: true, value: redactMediaValue(value) };
    } catch (error) {
      emit("progress", { command: command, phase: "failed", requestId: context.requestId });
      return normalizeMediaError(error);
    }
  }

  /** 应用退出：取消在途 worker（绝不写 Task / Job 状态）。 */
  function dispose() {
    let cancelled = 0;
    try { cancelled = runner.cancelAll("MEDIA_SHUTDOWN"); } catch { /* 已停 */ }
    return { cancelled: cancelled };
  }

  const dependencies = Object.freeze({
    userDataDir: !!userDataDir,
    mediaDir: !!mediaDir,
    database: !!db,
    identity: !!authorization,
    posterCache: !!posterCache,
    // 键名避开 isSecretKey 的子串（dxos-foundation-mask.cjs:12）
    runner: typeof runner.start === "function",
    workerEntry: !!workerEntry,
    // 键名避开 isSecretKey 的子串（dxos-foundation-mask.cjs:12）
    ffmpegBinary: !!ffmpegPath,
    ffprobeBinary: !!ffprobePath,
  });

  return {
    execute,
    setEventSink,
    emitEvent: emit,
    dispose,
    posterCache,
    paths: mediaDir ? { root: mediaDir } : null,
    dependencies,
    leaseMs,
    /** 供测试与实验直接调用（不经 IPC）：受监督 worker 一步。 */
    runWorker,
    runOneRenderJob,
  };
}

module.exports = { createMediaBundle, HOST_APP_ID, DEFAULT_LEASE_MS, DEFAULT_WORKER_TIMEOUT_MS, DEFAULT_POSTER_TIMEOUT_MS };
