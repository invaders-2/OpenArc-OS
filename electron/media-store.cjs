/**
 * B5a · 媒体域持久层 + 封面缓存（移植自 DX OS 0.5.1 server/video/videoStore.ts:1-244 与 posterCache.ts:1-73）。
 *
 * ## 来源
 *   · server/video/videoStore.ts:16-58   video_projects / video_assets / video_render_jobs 三张表 + 索引
 *   · server/video/videoStore.ts:71-244  逐函数移植（函数名与语义对应，行号见各函数处注释）
 *   · server/video/posterCache.ts:7-73   进程内 single-flight + 失败退避 + 有界并发 + 磁盘缓存
 *
 * ## 数据库句柄与依赖注入
 *   configureMediaStore({ db, mediaDir, clock, idFactory })
 *     · db       —— node:sqlite DatabaseSync（prepare/run/get/all）；
 *     · mediaDir —— <userData>/dxos/media（dxos-foundation-paths.cjs:18 已登记该目录）；
 *     · clock / idFactory —— 可选，默认 Date.now / randomUUID。
 *   resetMediaStoreForTests() —— 清空注入，供测试隔离。
 *
 * ## 与源不同的点（有意为之，其余逐字）
 *   · better-sqlite3 的 ccsDb.transaction(fn).immediate() 换成模块内 writeTransaction()：BEGIN IMMEDIATE / COMMIT / ROLLBACK；
 *   · 表结构只新增（IF NOT EXISTS），由 identity-store.cjs 的 v24 迁移调用 applyDxosMediaLayer(db) 建好；
 *     本文件同时导出 MEDIA_DDL 作为唯一真值，不让迁移框架复制第二份 SQL；
 *   · 无 HTTP：publicVideoRenderJob 不再返回 /api/video/render-jobs/:id/file 的 downloadUrl，
 *     改为返回成片的**相对文件名**（outputRelativePath）—— 绝对路径永不过 IPC（硬约束）；
 *   · videoAssetView 同样只回相对文件名，不回 file_path；
 *   · 源里 worker 自续租（videoWorker.ts:32-34）拆开：续租入口是 heartbeatVideoRenderJob，
 *     由受监督的媒体服务在 worker 运行期间按租约 1/3 周期调用（见 media-service.cjs）。
 */
"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const mediaDomain = require("./media-domain.cjs");
const foundationErrors = require("./dxos-foundation-errors.cjs");

const { createMediaError, MEDIA_ERR_INVALID_INPUT, MEDIA_ERR_NOT_FOUND, MEDIA_ERR_CONFLICT, MEDIA_ERR_FORBIDDEN, MEDIA_ERR_DEPENDENCY_UNAVAILABLE, MEDIA_ERR_POSTER_FAILED, MEDIA_ERR_INTERNAL } = mediaDomain;

/** 依赖未注入时的结构化错误码（与 agent-task-store.cjs:48 同一做法）。 */
const MEDIA_UNAVAILABLE = MEDIA_ERR_DEPENDENCY_UNAVAILABLE;

// ---------------------------------------------------------------------------
// 表结构（唯一真值；v24 建媒体三表，v30 追加草稿表）
// 源 videoStore.ts:16-58 的 CREATE TABLE / CREATE INDEX 原样搬运，全部 IF NOT EXISTS 可重放。
// video_assets / video_render_jobs 指向 video_projects 的外键保留（三张表同属本层新建，
// 不涉及 P1 跳过的 OpenArc 既有表，见 dxos-foundation-schema.cjs:26-35 的 FK 判据）。
// ---------------------------------------------------------------------------
const MEDIA_DDL = Object.freeze([
  "CREATE TABLE IF NOT EXISTS video_projects (\n  id TEXT PRIMARY KEY,\n  owner_id TEXT NOT NULL,\n  name TEXT NOT NULL,\n  status TEXT NOT NULL DEFAULT 'draft',\n  created_at INTEGER NOT NULL,\n  updated_at INTEGER NOT NULL\n)",
  "CREATE TABLE IF NOT EXISTS video_assets (\n  id TEXT PRIMARY KEY,\n  project_id TEXT NOT NULL REFERENCES video_projects(id) ON DELETE CASCADE,\n  owner_id TEXT NOT NULL,\n  name TEXT NOT NULL,\n  mime TEXT NOT NULL,\n  size INTEGER NOT NULL,\n  kind TEXT NOT NULL,\n  file_path TEXT NOT NULL UNIQUE,\n  metadata_json TEXT NOT NULL,\n  created_at INTEGER NOT NULL\n)",
  "CREATE TABLE IF NOT EXISTS video_render_jobs (\n  id TEXT PRIMARY KEY,\n  project_id TEXT NOT NULL REFERENCES video_projects(id) ON DELETE CASCADE,\n  owner_id TEXT NOT NULL,\n  timeline_json TEXT NOT NULL,\n  timeline_version INTEGER NOT NULL,\n  status TEXT NOT NULL,\n  progress INTEGER NOT NULL DEFAULT 0,\n  worker_id TEXT,\n  lease_until INTEGER,\n  heartbeat_at INTEGER,\n  output_path TEXT,\n  error TEXT,\n  created_at INTEGER NOT NULL,\n  updated_at INTEGER NOT NULL,\n  started_at INTEGER,\n  completed_at INTEGER\n)",
  "CREATE INDEX IF NOT EXISTS idx_video_assets_project ON video_assets(project_id, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_video_jobs_queue ON video_render_jobs(status, lease_until, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_video_jobs_project ON video_render_jobs(project_id, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_video_jobs_owner ON video_render_jobs(owner_id, created_at DESC)",
  `CREATE TABLE IF NOT EXISTS video_project_drafts (
    project_id TEXT NOT NULL REFERENCES video_projects(id) ON DELETE CASCADE,
    owner_id TEXT NOT NULL,
    quick_json TEXT NOT NULL,
    timeline_json TEXT NOT NULL,
    sources_json TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, owner_id)
  )`,
]);

/** @returns {string[]} DDL 语句副本（调用方修改不影响模块内常量）。 */
function mediaDdl() {
  return MEDIA_DDL.slice();
}

/** v24/v30 共用幂等媒体 DDL；失败随对应外层迁移事务整级回滚。 */
function applyDxosMediaLayer(db) {
  for (const statement of MEDIA_DDL) db.exec(statement);
}

// ---------------------------------------------------------------------------
// 依赖注入
// ---------------------------------------------------------------------------
let mediaDb = null;
let mediaDirs = null;
let mediaClock = () => Date.now();
let mediaIdFactory = () => randomUUID();

function configureMediaStore(options) {
  const opts = options || {};
  if (opts.db) mediaDb = opts.db;
  if (opts.mediaDir) {
    const root = path.resolve(String(opts.mediaDir));
    mediaDirs = {
      root,
      assets: path.join(root, "assets"),
      renders: path.join(root, "renders"),
      posters: path.join(root, "posters"),
      plans: path.join(root, "plans"),
      tmp: path.join(root, "tmp"),
    };
  }
  if (typeof opts.clock === "function") mediaClock = opts.clock;
  if (typeof opts.idFactory === "function") mediaIdFactory = opts.idFactory;
  return { db: mediaDb, mediaDir: mediaDirs ? mediaDirs.root : null };
}

function resetMediaStoreForTests() {
  mediaDb = null;
  mediaDirs = null;
  mediaClock = () => Date.now();
  mediaIdFactory = () => randomUUID();
}

function getMediaDb() {
  if (!mediaDb) {
    const error = new Error("media-store 未注入数据库句柄（configureMediaStore({ db })）");
    error.code = MEDIA_UNAVAILABLE;
    error.dependency = "db";
    throw error;
  }
  return mediaDb;
}

function getMediaDirs() {
  if (!mediaDirs) {
    const error = new Error("media-store 未注入媒体目录（configureMediaStore({ mediaDir })）");
    error.code = MEDIA_UNAVAILABLE;
    error.dependency = "mediaDir";
    throw error;
  }
  return mediaDirs;
}

function now() {
  return mediaClock();
}

/** 源 videoStore.ts:39-41（better-sqlite3 ccsDb.transaction(fn).immediate()）的等价实现。 */
function writeTransaction(work) {
  const db = getMediaDb();
  if (db.isTransaction || db.inTransaction) return work();
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = work();
    db.exec("COMMIT");
    return out;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* 已回滚 */
    }
    throw error;
  }
}

function json(value) {
  return JSON.stringify(value === null || value === undefined ? null : value);
}

// ---------------------------------------------------------------------------
// 项目 / 素材（源 videoStore.ts:72-145）
// ---------------------------------------------------------------------------

/** 源 videoStore.ts:72-76 */
function requireUuid(value, label) {
  const id = String(value || "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw createMediaError(MEDIA_ERR_INVALID_INPUT, label + "无效");
  return id;
}

/** 源 videoStore.ts:78-87 */
function ensureVideoProject(input) {
  const db = getMediaDb();
  const id = requireUuid(input && input.id, "视频项目 ID");
  const ownerId = String((input && input.ownerId) || "").trim();
  if (!ownerId) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "视频项目 ownerId 必填");
  const existing = db.prepare("SELECT * FROM video_projects WHERE id=?").get(id);
  if (existing && existing.owner_id !== ownerId) throw createMediaError(MEDIA_ERR_FORBIDDEN, "没有该视频项目的权限");
  const ts = now();
  const name = String((input && input.name) || "未命名视频项目").trim().slice(0, 120) || "未命名视频项目";
  db.prepare("INSERT INTO video_projects(id,owner_id,name,status,created_at,updated_at) VALUES (?,?,?,'draft',?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,updated_at=excluded.updated_at WHERE owner_id=excluded.owner_id")
    .run(id, ownerId, name, ts, ts);
  return id;
}

/** 源 videoStore.ts:89-95 */
function kindFromMime(mime, name) {
  const type = String(mime || "");
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  if (type.startsWith("image/")) return "image";
  if (/\.(srt|vtt)$/i.test(String(name || ""))) return "subtitle";
  throw createMediaError(MEDIA_ERR_INVALID_INPUT, "不支持的素材类型");
}

/** 源 videoStore.ts:97-114 */
function saveVideoAsset(input) {
  const db = getMediaDb();
  const dirs = getMediaDirs();
  const projectId = ensureVideoProject({ id: input.projectId, ownerId: input.ownerId, name: input.projectName });
  const id = mediaIdFactory();
  const sourceExt = path.extname(String(input.name || "")).toLowerCase();
  const extension = /^\.[a-z0-9]{1,8}$/.test(sourceExt) ? sourceExt : ".bin";
  const filePath = path.join(dirs.assets, id + extension);
  const kind = kindFromMime(input.mime, input.name);
  const ts = now();
  fs.mkdirSync(dirs.assets, { recursive: true });
  fs.writeFileSync(filePath, input.buffer, { flag: "wx" });
  try {
    db.prepare("INSERT INTO video_assets(id,project_id,owner_id,name,mime,size,kind,file_path,metadata_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(id, projectId, input.ownerId, String(input.name || "").slice(0, 255), String(input.mime || ""), input.buffer.length, kind, filePath, json(input.probe), ts);
  } catch (error) {
    try { fs.unlinkSync(filePath); } catch { /* 清理失败不掩盖原始错误 */ }
    throw error;
  }
  return videoAssetView(getVideoAssetRow(id, input.ownerId));
}

/** 源 videoStore.ts:116-118 */
function getVideoAssetRow(id, ownerId) {
  const db = getMediaDb();
  return ownerId
    ? db.prepare("SELECT * FROM video_assets WHERE id=? AND owner_id=?").get(id, ownerId)
    : db.prepare("SELECT * FROM video_assets WHERE id=?").get(id);
}

/** 源 videoStore.ts:120-123 */
function listVideoAssetRows(projectId, ownerId) {
  const db = getMediaDb();
  ensureOwnedProject(projectId, ownerId);
  return db.prepare("SELECT * FROM video_assets WHERE project_id=? AND owner_id=? ORDER BY created_at DESC").all(projectId, ownerId);
}

/** 源 videoStore.ts:125-135 */
function deleteVideoAsset(id, ownerId) {
  const db = getMediaDb();
  const row = getVideoAssetRow(id, ownerId);
  if (!row) throw createMediaError(MEDIA_ERR_NOT_FOUND, "素材不存在或无权删除");
  const active = db.prepare("SELECT id FROM video_render_jobs WHERE project_id=? AND owner_id=? AND status IN ('queued','running','interrupted') LIMIT 1").get(row.project_id, ownerId);
  if (active) throw createMediaError(MEDIA_ERR_CONFLICT, "项目存在进行中的渲染任务，请先取消后再删除素材");
  if (fs.existsSync(row.file_path)) fs.unlinkSync(row.file_path);
  const changed = db.prepare("DELETE FROM video_assets WHERE id=? AND owner_id=?").run(id, ownerId).changes;
  if (!changed) throw createMediaError(MEDIA_ERR_CONFLICT, "素材删除失败");
  return { id, projectId: row.project_id };
}

/** 源 videoStore.ts:137-145 —— 去掉 file_path，只回相对文件名。 */
function videoAssetView(row) {
  const metadata = JSON.parse(row.metadata_json || "{}");
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    name: row.name,
    mime: row.mime,
    size: row.size,
    durationMs: metadata.durationMs,
    width: metadata.width,
    height: metadata.height,
    fps: metadata.fps,
    hasVideo: metadata.hasVideo,
    hasAudio: metadata.hasAudio,
    formatName: metadata.formatName,
    bitRate: metadata.bitRate,
    videoCodec: metadata.videoCodec,
    audioCodec: metadata.audioCodec,
    audioChannels: metadata.audioChannels,
    sampleRate: metadata.sampleRate,
    probeSource: "ffprobe",
    serverStored: true,
    relativePath: path.basename(row.file_path),
    createdAt: row.created_at,
  };
}

/** 源 videoStore.ts:147-150 */
function ensureOwnedProject(projectId, ownerId) {
  const db = getMediaDb();
  const row = db.prepare("SELECT id FROM video_projects WHERE id=? AND owner_id=?").get(projectId, ownerId);
  if (!row) throw createMediaError(MEDIA_ERR_NOT_FOUND, "视频项目不存在或无权访问");
  return row.id;
}

function videoDraftView(row) {
  if (!row) return null;
  return {
    projectId: row.project_id,
    quick: JSON.parse(row.quick_json),
    timeline: JSON.parse(row.timeline_json),
    sources: JSON.parse(row.sources_json),
    version: row.version,
    updatedAt: row.updated_at,
  };
}
function getVideoProjectDraft(projectId, ownerId) {
  ensureOwnedProject(projectId, ownerId);
  return videoDraftView(getMediaDb().prepare("SELECT * FROM video_project_drafts WHERE project_id=? AND owner_id=?").get(projectId, ownerId));
}
function latestVideoProjectDraft(ownerId) {
  return videoDraftView(getMediaDb().prepare("SELECT * FROM video_project_drafts WHERE owner_id=? ORDER BY updated_at DESC,project_id DESC LIMIT 1").get(ownerId));
}
function draftParts(input) {
  const quick = input && input.quick && typeof input.quick === "object" && !Array.isArray(input.quick) ? input.quick : {};
  const timeline = input && input.timeline;
  const sources = input && input.sources;
  if (!timeline || typeof timeline !== "object" || Array.isArray(timeline)) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "草稿 timeline 必须是对象");
  if (!sources || typeof sources !== "object" || Array.isArray(sources)) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "草稿 sources 必须是对象");
  const parts = { quick: json(quick), timeline: json(timeline), sources: json(sources) };
  if ((parts.quick.length + parts.timeline.length + parts.sources.length) > 8 * 1024 * 1024) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "视频草稿超过 8 MB 上限");
  return parts;
}
function saveVideoProjectDraft(input) {
  const projectId = ensureOwnedProject(input.projectId, input.ownerId);
  const parts = draftParts(input);
  return writeTransaction(() => {
    const db = getMediaDb();
    const current = db.prepare("SELECT version FROM video_project_drafts WHERE project_id=? AND owner_id=?").get(projectId, input.ownerId);
    const expectedVersion = input.expectedVersion;
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0 || (current ? current.version !== expectedVersion : expectedVersion !== 0)) {
      throw createMediaError(MEDIA_ERR_CONFLICT, "视频草稿版本冲突，请重新读取", { expectedVersion, currentVersion: current ? current.version : 0 });
    }
    const ts = now();
    if (current) {
      const changed = db.prepare("UPDATE video_project_drafts SET quick_json=?,timeline_json=?,sources_json=?,version=version+1,updated_at=? WHERE project_id=? AND owner_id=? AND version=?")
        .run(parts.quick, parts.timeline, parts.sources, ts, projectId, input.ownerId, expectedVersion).changes;
      if (!changed) throw createMediaError(MEDIA_ERR_CONFLICT, "视频草稿版本冲突，请重新读取");
    } else {
      db.prepare("INSERT INTO video_project_drafts(project_id,owner_id,quick_json,timeline_json,sources_json,version,updated_at) VALUES (?,?,?,?,?,1,?)")
        .run(projectId, input.ownerId, parts.quick, parts.timeline, parts.sources, ts);
    }
    return getVideoProjectDraft(projectId, input.ownerId);
  });
}
function importVideoProjectDraft(input) {
  const projectId = ensureOwnedProject(input.projectId, input.ownerId);
  const parts = draftParts(input);
  return writeTransaction(() => {
    const existing = getVideoProjectDraft(projectId, input.ownerId);
    if (existing) return { imported: false, draft: existing };
    const inserted = getMediaDb().prepare("INSERT INTO video_project_drafts(project_id,owner_id,quick_json,timeline_json,sources_json,version,updated_at) VALUES (?,?,?,?,?,1,?) ON CONFLICT(project_id,owner_id) DO NOTHING")
      .run(projectId, input.ownerId, parts.quick, parts.timeline, parts.sources, now()).changes;
    return { imported: inserted > 0, draft: getVideoProjectDraft(projectId, input.ownerId) };
  });
}

/**
 * task-20：多轨时间线的 plan 预览/校验（只服务主进程内部命令；路径绝不过 IPC）。
 * 先对齐时长，再校验并编译；返回对齐后的时间线、issues、plan 与素材只读视图。
 */
function compileVideoTimelinePlan({ projectId, ownerId, timeline } = {}) {
  ensureOwnedProject(projectId, ownerId);
  const rows = listVideoAssetRows(projectId, ownerId);
  const assets = rows.map(videoAssetView);
  const aligned = mediaDomain.alignTimelineDuration(timeline);
  const issues = mediaDomain.validateTimeline(aligned.timeline, assets);
  const plan = mediaDomain.compileRenderPlan(aligned.timeline, assets, (asset) => {
    const row = rows.find((candidate) => candidate.id === asset.id);
    if (!row) throw createMediaError(MEDIA_ERR_NOT_FOUND, "服务端缺少素材：" + asset.name);
    return row.file_path;
  });
  return { timeline: aligned.timeline, changed: aligned.changed, issues, plan };
}

/** task-20：只校验 + 对齐（不编译、不要求有可视片段），供前端多轨编辑器即时反馈。 */
function validateVideoTimeline({ projectId, ownerId, timeline } = {}) {
  ensureOwnedProject(projectId, ownerId);
  const assets = listVideoAssetRows(projectId, ownerId).map(videoAssetView);
  const aligned = mediaDomain.alignTimelineDuration(timeline);
  return {
    timeline: aligned.timeline, changed: aligned.changed,
    issues: mediaDomain.validateTimeline(aligned.timeline, assets),
    assetCount: assets.length,
  };
}

/** 返回素材的绝对磁盘路径（只在主进程内部使用，绝不过 IPC）。 */
function mediaAssetAbsolutePath(id, ownerId) {
  const row = getVideoAssetRow(id, ownerId);
  if (!row) throw createMediaError(MEDIA_ERR_NOT_FOUND, "素材不存在或无权访问");
  return row.file_path;
}

// ---------------------------------------------------------------------------
// 渲染作业（源 videoStore.ts:152-244）
// ---------------------------------------------------------------------------

/** 源 videoStore.ts:152-165 */
function createVideoRenderJob(input) {
  const db = getMediaDb();
  ensureVideoProject({ id: input.projectId, ownerId: input.ownerId, name: input.projectName });
  const rows = listVideoAssetRows(input.projectId, input.ownerId);
  const assets = rows.map(videoAssetView);
  // task-20：入队前先把时长对齐到片段最大结束时间（不改片段位置），再编译/校验。
  const aligned = mediaDomain.alignTimelineDuration(input.timeline);
  const timeline = aligned.timeline;
  mediaDomain.compileRenderPlan(timeline, assets, (asset) => {
    const row = rows.find((candidate) => candidate.id === asset.id);
    if (!row) throw createMediaError(MEDIA_ERR_NOT_FOUND, "服务端缺少素材：" + asset.name);
    return row.file_path;
  });
  const id = mediaIdFactory();
  const ts = now();
  db.prepare("INSERT INTO video_render_jobs(id,project_id,owner_id,timeline_json,timeline_version,status,progress,created_at,updated_at) VALUES (?,?,?,?,?,'queued',0,?,?)")
    .run(id, input.projectId, input.ownerId, json(timeline), Number(timeline && timeline.version) || 0, ts, ts);
  return getVideoRenderJob(id, input.ownerId);
}

/** 源 videoStore.ts:167-169 */
function getVideoRenderJob(id, ownerId) {
  const db = getMediaDb();
  return ownerId
    ? db.prepare("SELECT * FROM video_render_jobs WHERE id=? AND owner_id=?").get(id, ownerId)
    : db.prepare("SELECT * FROM video_render_jobs WHERE id=?").get(id);
}

/** 新增（源只有按 id 取）：按项目 / 状态列出，供 media/render/list。 */
function listVideoRenderJobs(input) {
  const db = getMediaDb();
  const ownerId = String((input && input.ownerId) || "").trim();
  if (!ownerId) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "render/list 需要 ownerId");
  const projectId = input && input.projectId ? String(input.projectId) : null;
  const statuses = Array.isArray(input && input.statuses) ? input.statuses.filter((s) => typeof s === "string") : [];
  const limit = Math.max(1, Math.min(200, Number.isFinite(input && input.limit) ? Math.round(input.limit) : 50));
  const clauses = ["owner_id=?"];
  const params = [ownerId];
  if (projectId) { clauses.push("project_id=?"); params.push(projectId); }
  if (statuses.length) { clauses.push("status IN (" + statuses.map(() => "?").join(",") + ")"); params.push(...statuses); }
  params.push(limit);
  return db.prepare("SELECT * FROM video_render_jobs WHERE " + clauses.join(" AND ") + " ORDER BY created_at DESC LIMIT ?").all(...params);
}

/** 源 videoStore.ts:171-177 —— 去掉 downloadUrl，只回相对文件名。 */
function publicVideoRenderJob(row) {
  if (!row) return null;
  const completed = row.status === "completed" && !!row.output_path;
  return {
    id: row.id,
    projectId: row.project_id,
    timelineVersion: row.timeline_version,
    status: row.status,
    progress: row.progress,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    hasOutput: completed && fs.existsSync(row.output_path),
    outputRelativePath: completed ? path.basename(row.output_path) : null,
    workerAssigned: !!row.worker_id,
  };
}

/** 源 videoStore.ts:179-183 —— 只做 UPDATE，事务由调用方决定（避免嵌套 BEGIN）。 */
function recoverExpiredVideoJobsRaw(ts) {
  const db = getMediaDb();
  return db.prepare("UPDATE video_render_jobs SET status='interrupted',worker_id=NULL,lease_until=NULL,heartbeat_at=NULL,updated_at=? WHERE status='running' AND lease_until IS NOT NULL AND lease_until<?").run(ts, ts).changes;
}

function recoverExpiredVideoJobs(ts) {
  const at = Number.isFinite(ts) ? ts : now();
  return writeTransaction(() => recoverExpiredVideoJobsRaw(at));
}

/** 源 videoStore.ts:185-195 */
function claimNextVideoRenderJob(workerId, leaseMs) {
  const at = now();
  return writeTransaction(() => {
    recoverExpiredVideoJobsRaw(at);
    const row = getMediaDb().prepare("SELECT id FROM video_render_jobs WHERE status IN ('queued','interrupted') ORDER BY created_at LIMIT 1").get();
    if (!row) return undefined;
    const ts = now();
    const changed = getMediaDb().prepare("UPDATE video_render_jobs SET status='running',worker_id=?,lease_until=?,heartbeat_at=?,started_at=COALESCE(started_at,?),progress=MAX(progress,1),error=NULL,updated_at=? WHERE id=? AND status IN ('queued','interrupted')")
      .run(workerId, ts + leaseMs, ts, ts, ts, row.id).changes;
    return changed ? getVideoRenderJob(row.id) : undefined;
  });
}

/** 源 videoStore.ts:197-204 */
function heartbeatVideoRenderJob(id, workerId, leaseMs, progress) {
  const db = getMediaDb();
  const ts = now();
  const safeProgress = progress == null ? undefined : Math.max(1, Math.min(99, Math.round(progress)));
  const result = safeProgress == null
    ? db.prepare("UPDATE video_render_jobs SET heartbeat_at=?,lease_until=?,updated_at=? WHERE id=? AND worker_id=? AND status='running'").run(ts, ts + leaseMs, ts, id, workerId)
    : db.prepare("UPDATE video_render_jobs SET heartbeat_at=?,lease_until=?,progress=?,updated_at=? WHERE id=? AND worker_id=? AND status='running'").run(ts, ts + leaseMs, safeProgress, ts, id, workerId);
  return result.changes > 0;
}

/** 源 videoStore.ts:206-218 */
function completeVideoRenderJob(id, workerId, partialPath) {
  const db = getMediaDb();
  const dirs = getMediaDirs();
  const outputPath = path.join(dirs.renders, id + ".mp4");
  fs.mkdirSync(dirs.renders, { recursive: true });
  if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
  fs.renameSync(partialPath, outputPath);
  const ts = now();
  const changed = db.prepare("UPDATE video_render_jobs SET status='completed',progress=100,output_path=?,lease_until=NULL,heartbeat_at=NULL,completed_at=?,updated_at=? WHERE id=? AND worker_id=? AND status='running'").run(outputPath, ts, ts, id, workerId).changes;
  if (!changed) {
    try { fs.unlinkSync(outputPath); } catch { /* 已清理 */ }
    throw createMediaError(MEDIA_ERR_CONFLICT, "渲染任务已不再由当前 Worker 持有");
  }
  return outputPath;
}

/** 源 videoStore.ts:220-224 —— 错误文本先脱敏（绝对路径 / 凭据）再落库。 */
function failVideoRenderJob(id, workerId, error) {
  const db = getMediaDb();
  const ts = now();
  const message = foundationErrors.redactText(String(error == null ? "渲染失败" : error)).slice(0, 2000);
  return db.prepare("UPDATE video_render_jobs SET status='failed',error=?,lease_until=NULL,heartbeat_at=NULL,completed_at=?,updated_at=? WHERE id=? AND worker_id=? AND status='running'").run(message, ts, ts, id, workerId).changes > 0;
}

/** 源 videoStore.ts:226-232 */
function cancelVideoRenderJob(id, ownerId) {
  const db = getMediaDb();
  const ts = now();
  const changed = db.prepare("UPDATE video_render_jobs SET status='cancelled',lease_until=NULL,completed_at=?,updated_at=? WHERE id=? AND owner_id=? AND status IN ('queued','running','interrupted')").run(ts, ts, id, ownerId).changes;
  if (!changed) throw createMediaError(MEDIA_ERR_CONFLICT, "渲染任务不存在或无法取消");
  return getVideoRenderJob(id, ownerId);
}

/** 源 videoStore.ts:234-244 */
function renderJobExecutionData(job, attemptId) {
  const rows = listVideoAssetRows(job.project_id, job.owner_id);
  const timeline = JSON.parse(job.timeline_json);
  const plan = mediaDomain.compileRenderPlan(timeline, rows.map(videoAssetView), (asset) => {
    const row = rows.find((candidate) => candidate.id === asset.id);
    if (!row) throw createMediaError(MEDIA_ERR_NOT_FOUND, "服务端缺少素材：" + asset.name);
    return row.file_path;
  });
  const attempt = String(attemptId || "").replace(/[^a-z0-9_-]/gi, "").slice(0, 80);
  const dirs = getMediaDirs();
  return { plan, partialPath: path.join(dirs.renders, job.id + (attempt ? "." + attempt : "") + ".partial.mp4") };
}

// ---------------------------------------------------------------------------
// 封面缓存（源 posterCache.ts:7-73）
// ---------------------------------------------------------------------------

/**
 * 源 posterCache.ts:7-50 createVideoPosterCache。
 * render(source, target, size) 由调用方注入（media-service 用受监督 worker 跑 ffmpeg）；
 * 返回的 get(source, size) 附带 invalidate / keyFor / stats，供 media/poster/invalidate 与测试使用。
 */
function createVideoPosterCache(cacheDir, render) {
  const jobs = new Map();
  const failures = new Map();
  const waiters = [];
  let active = 0;
  let unavailableUntil = 0;
  const renderImpl = typeof render === "function" ? render : null;

  async function keyFor(source, size) {
    const info = await fsp.stat(source);
    return mediaDomain.posterCacheKey(source, info, size);
  }

  async function get(source, size) {
    if (typeof renderImpl !== "function") throw createMediaError(MEDIA_ERR_DEPENDENCY_UNAVAILABLE, "封面缓存未注入渲染实现", { dependency: "ffmpeg" });
    const info = await fsp.stat(source);
    const key = mediaDomain.posterCacheKey(source, info, size);
    const target = path.join(cacheDir, key + ".jpg");
    const hit = await fsp.stat(target).then((value) => value.size > 0, () => false);
    if (hit) return target;
    const existing = jobs.get(key);
    if (existing) return existing;
    const ts = Date.now();
    for (const [id, until] of failures) if (until <= ts) failures.delete(id);
    if ((failures.get(key) || 0) > ts) throw createMediaError(MEDIA_ERR_POSTER_FAILED, "视频封面暂不可用");
    if (jobs.size >= 128) throw createMediaError(MEDIA_ERR_POSTER_FAILED, "视频封面队列已满，请稍后重试");
    const job = (async () => {
      if (active >= 2) await new Promise((resolve) => waiters.push(resolve));
      else active++;
      const temporary = path.join(cacheDir, key + "." + randomUUID() + ".jpg");
      try {
        if (Date.now() < unavailableUntil) throw createMediaError(MEDIA_ERR_DEPENDENCY_UNAVAILABLE, "FFmpeg 暂不可用", { dependency: "ffmpeg" });
        await fsp.mkdir(cacheDir, { recursive: true });
        await renderImpl(source, temporary, size);
        if (!(await fsp.stat(temporary)).size) throw createMediaError(MEDIA_ERR_POSTER_FAILED, "视频封面为空");
        await fsp.rename(temporary, target);
        return target;
      } catch (error) {
        if (error && (error.code === "ENOENT" || (error.detail && error.detail.dependency === "ffmpeg") || error.code === MEDIA_ERR_DEPENDENCY_UNAVAILABLE)) unavailableUntil = Date.now() + 60_000;
        if (failures.size >= 512) failures.delete(failures.keys().next().value);
        failures.set(key, Date.now() + 60_000);
        throw error;
      } finally {
        await fsp.rm(temporary, { force: true }).catch(() => {});
        const next = waiters.shift();
        if (next) next();
        else active--;
      }
    })().finally(() => jobs.delete(key));
    jobs.set(key, job);
    return job;
  }

  /** 失效：删除缓存文件与失败退避记录；找不到源文件时返回 false（不抛）。 */
  async function invalidate(source, size) {
    const info = await fsp.stat(source).catch(() => null);
    if (!info) return false;
    const key = mediaDomain.posterCacheKey(source, info, size);
    failures.delete(key);
    const target = path.join(cacheDir, key + ".jpg");
    return fsp.rm(target, { force: true }).then(() => true, () => false);
  }

  get.invalidate = invalidate;
  get.keyFor = keyFor;
  get.stats = () => ({ active, pending: jobs.size, failures: failures.size, unavailable: Date.now() < unavailableUntil });
  return get;
}

module.exports = {
  MEDIA_DDL,
  MEDIA_UNAVAILABLE,
  mediaDdl,
  applyDxosMediaLayer,
  configureMediaStore,
  resetMediaStoreForTests,
  getMediaDb,
  getMediaDirs,
  writeTransaction,
  requireUuid,
  ensureVideoProject,
  kindFromMime,
  saveVideoAsset,
  getVideoAssetRow,
  listVideoAssetRows,
  deleteVideoAsset,
  videoAssetView,
  ensureOwnedProject,
  getVideoProjectDraft,
  latestVideoProjectDraft,
  saveVideoProjectDraft,
  importVideoProjectDraft,
  mediaAssetAbsolutePath,
  createVideoRenderJob,
  getVideoRenderJob,
  listVideoRenderJobs,
  publicVideoRenderJob,
  recoverExpiredVideoJobs,
  claimNextVideoRenderJob,
  heartbeatVideoRenderJob,
  completeVideoRenderJob,
  failVideoRenderJob,
  cancelVideoRenderJob,
  renderJobExecutionData,
  compileVideoTimelinePlan,
  validateVideoTimeline,
  createVideoPosterCache,
};
