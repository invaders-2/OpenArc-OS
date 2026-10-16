/**
 * photos 域 · 纯逻辑层（**无 I/O，无 Electron**）。
 *
 * 逐函数移植自只读源（行号为源文件行号，源位于 DX OS 0.6.1 app.asar.unpacked/server/）：
 *   · photoSources.ts:9-10        imageTypes / videoTypes（MIME 白名单即"什么算照片/视频"）
 *   · photoSources.ts:11-14       落盘根 photos / sources-shared.json / sources-<sha256(userId)>.json
 *   · photoSources.ts:50-61       addPhotoSource（绝对路径 + realpath + isDirectory + 按路径去重）
 *   · photoSources.ts:62-64       removePhotoSource
 *   · photoSources.ts:65-95       createPhotoFolder / removePhotoFolder（级联子目录）/ assignPhotoFolder
 *   · photoSources.ts:96-114      resolvePhotoSourceFile（id 前缀 + 相对路径围栏 + realpath 再围栏）
 *   · photoSources.ts:115-145     listPhotoSources 的条目形状与 24 层 / 100k 上限
 *   · photoLibraryIndex.ts:14-65  createPhotoLibraryIndex（图片/视频判定、祖先文件夹链、share 继承、owner 过滤）
 *   · photoSourceVisualFeatures.ts:6-134  特征向量的 192 维 [0,1] 校验、候选/签名的上限口径、相关排序打分
 *   · index.ts:5743-6132          /api/photos/* 路由的入参归一与失败语义
 *
 * 为什么单独一层：photos:command 是本轮新增顶层 IPC 通道，"可调用哪些命令、入参怎么归一、
 * 相对路径怎么围栏、失败回什么码"必须先在一处冻结，再交给 photos-service.cjs 落盘、
 * photos-bootstrap.cjs 注册。命令表本身即白名单，未登记命令一律
 * PHOTOS_COMMAND_NOT_ALLOWED，不做动态 dispatch。
 *
 * 与源的三处既定差异（都在 service 层落地，这里只定语义）：
 *   1. 源 index.ts:5743 的 GET /api/photos/sources 回绝对路径 path；本仓遵循 foundation
 *      "宿主路径不过 IPC"（dxos-foundation-errors.cjs:47 会把 /Users/... 整体替换成 <path>），
 *      因此 source 视图只回 id / name / available，绝不回宿主绝对路径。
 *   2. 源所有列表接口都不分页（只靠 items.length > 100_000 兜底）；而 foundation 的
 *      redactValue 会把数组静默截到 100 项（dxos-foundation-errors.cjs:68），所以本仓
 *      所有列表命令都带显式分页与 truncated 标记，保证渲染层看到的是真实边界。
 *   3. 源 photoSourceVisualFeatures.ts:24/:66 直接用 ccsDb 单例；本仓改为注入
 *      node:sqlite DatabaseSync（identity.db），未注入即结构化不可用，不新建第二套库。
 */
"use strict";

const path = require("node:path");
const { createHash } = require("node:crypto");
const foundationErrors = require("./dxos-foundation-errors.cjs");

// ---------------------------------------------------------------------------
// 常量（源 photoSources.ts:9-14、photoLibraryIndex.ts:25-26）
// ---------------------------------------------------------------------------

/** 源 photoSources.ts:9。 */
const PHOTO_IMAGE_TYPES = Object.freeze({
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
});

/** 源 photoSources.ts:10。 */
const PHOTO_VIDEO_TYPES = Object.freeze({
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
});

/** 源 photoLibraryIndex.ts:25-26：虚拟树里的图片/视频扩展名兜底（mime 缺失时按名字判）。 */
const LIBRARY_IMAGE_EXTENSIONS = Object.freeze(["png", "jpg", "jpeg", "webp", "gif", "bmp", "svg", "avif"]);
const LIBRARY_VIDEO_EXTENSIONS = Object.freeze(["mp4", "webm", "mov", "m4v", "avi", "mkv"]);

/** 源 photoSources.ts:11-13。 */
const PHOTOS_DIR_NAME = "photos";
const PHOTOS_SOURCES_SHARED_FILE = "sources-shared.json";
const PHOTOS_SOURCES_LEGACY_RE = /^sources-[a-f0-9]{64}\.json$/;

/** 源 photoSources.ts:67：文件夹名上限（源是 name.length > 80）。 */
const PHOTOS_MAX_FOLDER_NAME_LENGTH = 80;
/** 源 photoSources.ts:121：目录递归深度上限。 */
const PHOTOS_MAX_WALK_DEPTH = 24;
/** 源 photoSources.ts:121：单次索引条目上限。 */
const PHOTOS_MAX_INDEX_ITEMS = 100_000;
/** 源 photoSources.ts:138：local: 前缀 + source.id + ':'。 */
const PHOTOS_LOCAL_PREFIX = "local:";
/** 源 photoLibraryIndex.ts:43：没有父文件夹时的显示名。 */
const PHOTOS_DESKTOP_LABEL = "桌面";
/** 源 photoSourceVisualFeatures.ts:8、:25、:43。 */
const PHOTOS_FEATURE_VECTOR_LENGTH = 192;
const PHOTOS_MAX_FEATURE_BATCH = 40;
/** 源 photoSourceVisualFeatures.ts:57、:71、:93、:128。 */
const PHOTOS_MAX_SIGNATURE_LENGTH = 1_000_000;
const PHOTOS_MAX_RANKED_IDS = 10_000;
const PHOTOS_MAX_ID_LENGTH = 1024;
/** 源 photoSources.ts:121 的"深度 + 条目"之外，本仓额外的接收上限。 */
const PHOTOS_MAX_ASSIGN_IDS = 500;

/**
 * 单页上限刻意等于 foundation 的数组截断长度（dxos-foundation-errors.cjs:68 把数组切到 100 项），
 * 这样一页永远不会被脱敏层二次截断；超过上限一律 INVALID_INPUT，而不是静默丢数据。
 */
const PHOTOS_PAGE_LIMIT_DEFAULT = 50;
const PHOTOS_PAGE_LIMIT_MAX = 100;

// ---------------------------------------------------------------------------
// 错误规约（与 MEDIA_* / FILE_TRANSFER_* 同形：域自有码，不并进 DXOS_*）
// ---------------------------------------------------------------------------

const PHOTOS_ERR_COMMAND_NOT_ALLOWED = "PHOTOS_COMMAND_NOT_ALLOWED";
const PHOTOS_ERR_NOT_READY = "PHOTOS_NOT_READY";
const PHOTOS_ERR_INVALID_INPUT = "PHOTOS_INVALID_INPUT";
const PHOTOS_ERR_UNAUTHENTICATED = "PHOTOS_UNAUTHENTICATED";
const PHOTOS_ERR_FORBIDDEN = "PHOTOS_FORBIDDEN";
const PHOTOS_ERR_NOT_FOUND = "PHOTOS_NOT_FOUND";
const PHOTOS_ERR_CONFLICT = "PHOTOS_CONFLICT";
const PHOTOS_ERR_PATH_ESCAPE = "PHOTOS_PATH_ESCAPE";
const PHOTOS_ERR_TOO_LARGE = "PHOTOS_TOO_LARGE";
const PHOTOS_ERR_DEPENDENCY_UNAVAILABLE = "PHOTOS_DEPENDENCY_UNAVAILABLE";
const PHOTOS_ERR_PROVIDER_UNAVAILABLE = "PHOTOS_PROVIDER_UNAVAILABLE";
const PHOTOS_ERR_PROVIDER_FAILED = "PHOTOS_PROVIDER_FAILED";
const PHOTOS_ERR_INTERNAL = "PHOTOS_INTERNAL";

const PHOTOS_ERROR_CODES = Object.freeze([
  PHOTOS_ERR_COMMAND_NOT_ALLOWED,
  PHOTOS_ERR_NOT_READY,
  PHOTOS_ERR_INVALID_INPUT,
  PHOTOS_ERR_UNAUTHENTICATED,
  PHOTOS_ERR_FORBIDDEN,
  PHOTOS_ERR_NOT_FOUND,
  PHOTOS_ERR_CONFLICT,
  PHOTOS_ERR_PATH_ESCAPE,
  PHOTOS_ERR_TOO_LARGE,
  PHOTOS_ERR_DEPENDENCY_UNAVAILABLE,
  PHOTOS_ERR_PROVIDER_UNAVAILABLE,
  PHOTOS_ERR_PROVIDER_FAILED,
  PHOTOS_ERR_INTERNAL,
]);

function createPhotosError(code, message, detail) {
  const err = new Error(foundationErrors.redactText(message == null ? code : message));
  err.name = "PhotosError";
  err.code = PHOTOS_ERROR_CODES.includes(code) ? code : PHOTOS_ERR_INTERNAL;
  if (detail !== undefined) err.detail = foundationErrors.redactValue(detail);
  return err;
}

function isPhotosError(err) {
  return !!err && typeof err === "object" && typeof err.code === "string" && PHOTOS_ERROR_CODES.includes(err.code);
}

function normalizePhotosError(err) {
  if (isPhotosError(err)) {
    const out = { ok: false, error: err.code, message: foundationErrors.redactText(err.message || err.code) || err.code };
    if (err.detail !== undefined) out.detail = foundationErrors.redactValue(err.detail);
    return out;
  }
  return foundationErrors.normalizeError(err, { fallbackCode: foundationErrors.DXOS_ERR_INTERNAL });
}

async function toPhotosIpcResult(action) {
  try {
    const value = typeof action === "function" ? await action() : await action;
    return { ok: true, value: foundationErrors.redactValue(value) };
  } catch (err) {
    return normalizePhotosError(err);
  }
}

function photosCommandNotAllowed(command) {
  return createPhotosError(
    PHOTOS_ERR_COMMAND_NOT_ALLOWED,
    "未知或未授权的 photos 命令：" + String(command == null ? "" : command),
    { command: command == null ? null : String(command) },
  );
}

// ---------------------------------------------------------------------------
// 命令白名单（顶层 IPC 面；risk / summary 供 UI 与审计）
// 命令名由 Lead 冻结，与 /api/photos/* 路由一一对应，不得改名。
// ---------------------------------------------------------------------------

const PHOTOS_COMMANDS = Object.freeze({
  "photos/sources/list": { risk: "read", summary: "列出本地照片来源及其分页条目（分页 + truncated 显式返回）" },
  "photos/sources/add": { risk: "manage", summary: "添加本地文件夹为照片来源（绝对路径 + 真实目录 + 按路径去重）" },
  "photos/sources/remove": { risk: "destructive", summary: "移除照片来源（未知 id 回 NOT_FOUND）" },
  "photos/folders/create": { risk: "manage", summary: "创建虚拟文件夹（可指定父文件夹，父不存在回 NOT_FOUND）" },
  "photos/folders/remove": { risk: "destructive", summary: "删除虚拟文件夹并级联删除子文件夹与归属" },
  "photos/folders/assign": { risk: "manage", summary: "把一批照片批量归入/移出虚拟文件夹（folderId=null 表示移出）" },
  "photos/library": { risk: "read", summary: "列出虚拟文件树里的图片/视频（按共享区可见性过滤，分页）" },
  "photos/sourceFile": { risk: "read", summary: "读取来源文件字节（base64url；宿主路径不过 IPC）" },
  "photos/sourceThumbnail": { risk: "read", summary: "生成/读取来源缩略图（sharp 缺失即结构化不可用，绝不回假图）" },
  "photos/importImage": { risk: "use", summary: "把图片导入画布或资产库（未注入导入器即结构化不可用）" },
  "photos/features/compute": { risk: "manage", summary: "写入 192 维视觉特征（源 mtime 变化即拒绝覆盖）" },
  "photos/features/query": { risk: "read", summary: "按图片 + mtime 批量读取视觉特征" },
  "photos/related/compute": { risk: "manage", summary: "保存相关推荐排序结果（按目录/描述签名分桶，丢弃旧目录）" },
  "photos/related/query": { risk: "use", summary: "查询或即时计算相关推荐（分页；缺特征向量回 ids=null）" },
  "photos/reversePrompt": { risk: "use", summary: "用已配置的视觉模型反推提示词（无供应商即结构化不可用）" },
  "photos/visionModels": { risk: "read", summary: "列出可用的视觉模型（没有供应商时 available=false 并给出配置提示）" },
  "photos/backgroundRemoval": { risk: "use", summary: "本地抠图（复用 media-background-removal.cjs，缺依赖即结构化不可用）" },
  "photos/health": { risk: "read", summary: "photos 域装配状态（来源数 / 虚拟文件夹数 / 依赖布尔事实，不含宿主路径）" },
});

function isPhotosCommand(command) {
  return typeof command === "string" && Object.prototype.hasOwnProperty.call(PHOTOS_COMMANDS, command);
}

function photosCommandEntry(command) {
  return isPhotosCommand(command) ? PHOTOS_COMMANDS[command] : null;
}

function listPhotosCommands() {
  return Object.keys(PHOTOS_COMMANDS).map((command) => ({
    command,
    risk: PHOTOS_COMMANDS[command].risk,
    summary: PHOTOS_COMMANDS[command].summary,
  }));
}

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

const isPlainObject = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const clipText = (value, max) => (typeof value === "string" ? value.slice(0, max) : "");

/** 路径包含判定：candidate 必须等于 root 或落在 root 之内（同 file-transfer-domain.cjs:268-272）。 */
function isContainedPath(root, candidate) {
  const base = path.resolve(String(root));
  const target = path.resolve(String(candidate));
  return target === base || target.startsWith(base + path.sep);
}

/** 源 photoSources.ts:13：每用户文件名 = sources-<sha256(userId)>.json。 */
function photosUserFileHash(userId) {
  return createHash("sha256").update(String(userId == null ? "" : userId)).digest("hex");
}

function photosUserFileName(userId) {
  return "sources-" + photosUserFileHash(userId) + ".json";
}

/** 源 photoSources.ts:108-109：按扩展名判 MIME；未知扩展名 = 不是媒体。 */
function photosMimeForName(name) {
  const extension = path.extname(String(name || "")).toLowerCase();
  return PHOTO_IMAGE_TYPES[extension] || PHOTO_VIDEO_TYPES[extension] || null;
}

function photosKindForMime(mime) {
  const value = String(mime || "").toLowerCase();
  if (value.startsWith("image/")) return "image";
  if (value.startsWith("video/")) return "video";
  return null;
}

/**
 * 源 photoLibraryIndex.ts:23-26：虚拟树节点判 kind。
 * 与源一致：mime 优先，mime 缺失/不识别时用扩展名兜底（含 svg / avi / mkv）。
 */
function classifyLibraryNode(node) {
  const mime = String((node && node.mime) || "").toLowerCase();
  const extension = String((node && node.name) || "").split(".").pop().toLowerCase();
  if (mime.startsWith("image/") || LIBRARY_IMAGE_EXTENSIONS.includes(extension)) return "image";
  if (mime.startsWith("video/") || LIBRARY_VIDEO_EXTENSIONS.includes(extension)) return "video";
  return null;
}

// ---------------------------------------------------------------------------
// 入参归一
// ---------------------------------------------------------------------------

/** 源 index.ts:5903：POST /api/photos/sources 的 body.path（源在 photoSources.ts:51 要求绝对路径）。 */
function normalizeSourcePath(raw) {
  if (typeof raw !== "string" || !raw.trim()) throw createPhotosError(PHOTOS_ERR_INVALID_INPUT, "请选择本机文件夹");
  const value = raw.trim();
  if (value.length > 4096) throw createPhotosError(PHOTOS_ERR_INVALID_INPUT, "文件夹路径过长");
  if (!path.isAbsolute(value)) throw createPhotosError(PHOTOS_ERR_INVALID_INPUT, "请选择本机文件夹（必须是绝对路径）");
  if (value.includes("\u0000")) throw createPhotosError(PHOTOS_ERR_INVALID_INPUT, "文件夹路径包含非法字符");
  return value;
}

function requireId(raw, label = "id") {
  if (typeof raw !== "string" || !raw.trim()) throw createPhotosError(PHOTOS_ERR_INVALID_INPUT, label + " 必填");
  const value = raw.trim();
  if (value.length > PHOTOS_MAX_ID_LENGTH) throw createPhotosError(PHOTOS_ERR_INVALID_INPUT, label + " 过长");
  return value;
}

/** 源 photoSources.ts:67：name.trim() 非空且 name.length <= 80。 */
function normalizeFolderName(raw) {
  if (typeof raw !== "string") throw createPhotosError(PHOTOS_ERR_INVALID_INPUT, "文件夹名称无效");
  if (!raw.trim() || raw.length > PHOTOS_MAX_FOLDER_NAME_LENGTH) {
    throw createPhotosError(PHOTOS_ERR_INVALID_INPUT, "文件夹名称无效", { maxLength: PHOTOS_MAX_FOLDER_NAME_LENGTH });
  }
  return raw.trim();
}

function normalizeOptionalParentId(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  return requireId(raw, "上级文件夹 id");
}

/** 源 index.ts:5913：Array.isArray(body.ids) ? body.ids.map(String) : []。 */
function normalizeAssignIds(raw) {
  const list = Array.isArray(raw) ? raw : [];
  if (!list.length) throw createPhotosError(PHOTOS_ERR_INVALID_INPUT, "请选择要归类的照片");
  if (list.length > PHOTOS_MAX_ASSIGN_IDS) {
    throw createPhotosError(PHOTOS_ERR_INVALID_INPUT, "单次最多归类 " + PHOTOS_MAX_ASSIGN_IDS + " 张照片", { max: PHOTOS_MAX_ASSIGN_IDS });
  }
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const id = String(item == null ? "" : item);
    if (!id || id.length > PHOTOS_MAX_ID_LENGTH || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  if (!out.length) throw createPhotosError(PHOTOS_ERR_INVALID_INPUT, "请选择要归类的照片");
  return out;
}

/** 分页归一：默认 50，上限 100（= foundation 数组截断长度，避免被二次静默截断）。 */
function normalizePagination(raw) {
  const body = isPlainObject(raw) ? raw : {};
  const rawOffset = body.offset;
  const rawLimit = body.limit;
  let offset = 0;
  if (rawOffset !== undefined && rawOffset !== null) {
    if (!Number.isSafeInteger(rawOffset) || rawOffset < 0) throw createPhotosError(PHOTOS_ERR_INVALID_INPUT, "offset 必须是非负整数");
    offset = rawOffset;
  }
  let limit = PHOTOS_PAGE_LIMIT_DEFAULT;
  if (rawLimit !== undefined && rawLimit !== null) {
    if (!Number.isSafeInteger(rawLimit) || rawLimit < 1 || rawLimit > PHOTOS_PAGE_LIMIT_MAX) {
      throw createPhotosError(PHOTOS_ERR_INVALID_INPUT, "limit 必须是 1.." + PHOTOS_PAGE_LIMIT_MAX + " 的整数", { max: PHOTOS_PAGE_LIMIT_MAX });
    }
    limit = rawLimit;
  }
  return { offset, limit };
}

/**
 * 源 photoSources.ts:96-101：local:<sourceId>:<relativePath> 的解析与围栏。
 * 这里只做纯字符串围栏（绝对路径 / '..' / '.' / 空段 / NUL）；realpath 级的第二次围栏在 store 层。
 */
function parseLocalPhotoId(raw) {
  if (typeof raw !== "string" || !raw.startsWith(PHOTOS_LOCAL_PREFIX)) return null;
  const rest = raw.slice(PHOTOS_LOCAL_PREFIX.length);
  const separator = rest.indexOf(":");
  if (separator <= 0) return null;
  const sourceId = rest.slice(0, separator);
  const relativePath = rest.slice(separator + 1);
  if (!sourceId || !relativePath || sourceId.length > PHOTOS_MAX_ID_LENGTH) return null;
  if (relativePath.length > 4096 || relativePath.includes("\u0000")) return null;
  if (path.isAbsolute(relativePath) || relativePath.startsWith("..")) return null;
  const segments = relativePath.split(/[\\/]/);
  if (segments.some((segment) => segment === ".." || segment === "." || segment === "")) return null;
  return { sourceId, relativePath: segments.join("/") };
}

/** 源 photoSourceVisualFeatures.ts:8：192 维、[0,1]、有限数。 */
function isValidFeatureVector(value) {
  return Array.isArray(value) && value.length === PHOTOS_FEATURE_VECTOR_LENGTH
    && value.every((number) => typeof number === "number" && Number.isFinite(number) && number >= 0 && number <= 1);
}

/** 源 photoSourceVisualFeatures.ts:11-19：请求项的形态校验。 */
function normalizeFeatureItem(raw) {
  if (!isPlainObject(raw)) return null;
  const id = typeof raw.id === "string" ? raw.id : null;
  if (!id || id.length > PHOTOS_MAX_ID_LENGTH) return null;
  if (!Number.isFinite(raw.updated_ts)) return null;
  return { id, updated_ts: Number(raw.updated_ts), features: raw.features };
}

function normalizeFeatureQueryItems(raw) {
  const list = Array.isArray(raw) ? raw.slice(0, PHOTOS_MAX_FEATURE_BATCH) : [];
  return list.map(normalizeFeatureItem).filter(Boolean).map((item) => ({ id: item.id, updated_ts: item.updated_ts }));
}

function normalizeFeatureWriteItems(raw) {
  const list = Array.isArray(raw) ? raw.slice(0, PHOTOS_MAX_FEATURE_BATCH) : [];
  const out = [];
  for (const value of list) {
    const item = normalizeFeatureItem(value);
    if (!item || !isValidFeatureVector(item.features)) continue;
    out.push({ id: item.id, updated_ts: item.updated_ts, features: item.features });
  }
  return out;
}

/** 源 index.ts:5884-5885：id / 两个签名 / updated_ts / folderId / candidates / semanticScores。 */
function normalizeRelatedKey(body) {
  const source = isPlainObject(body) ? body : {};
  const id = String(source.id == null ? "" : source.id);
  const catalogSignature = String(source.catalogSignature == null ? "" : source.catalogSignature);
  const descriptionSignature = String(source.descriptionSignature == null ? "" : source.descriptionSignature);
  if (catalogSignature.length > PHOTOS_MAX_SIGNATURE_LENGTH || descriptionSignature.length > PHOTOS_MAX_SIGNATURE_LENGTH) {
    throw createPhotosError(PHOTOS_ERR_INVALID_INPUT, "目录/描述签名过大");
  }
  return { id, catalogSignature, descriptionSignature };
}

function normalizeRelatedCandidate(raw) {
  if (!isPlainObject(raw)) return null;
  const id = typeof raw.id === "string" ? raw.id : null;
  if (!id || id.length > PHOTOS_MAX_ID_LENGTH) return null;
  if (!Number.isFinite(raw.updated_ts)) return null;
  return { id, updated_ts: Number(raw.updated_ts), folderId: raw.folderId == null ? null : String(raw.folderId) };
}

function normalizeSemanticEntries(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return list
    .filter((entry) => Array.isArray(entry) && typeof entry[0] === "string" && Number.isFinite(entry[1]))
    .map((entry) => [String(entry[0]), Number(entry[1])]);
}

// ---------------------------------------------------------------------------
// 图库条目与分页（源 photoSources.ts:115-145 / photoLibraryIndex.ts:41-63）
// ---------------------------------------------------------------------------

/** local: 来源条目视图（源 photoSources.ts:138，本仓加 kind 便于前端筛选）。 */
function photoItemView(entry, assignment) {
  const mime = String(entry.mime || "");
  return {
    id: entry.id,
    name: entry.name,
    sourceId: entry.sourceId,
    relativePath: entry.relativePath,
    folderPath: entry.folderPath,
    mime,
    kind: photosKindForMime(mime) || "image",
    size: Number(entry.size) || 0,
    updated_ts: Number(entry.updated_ts) || 0,
    virtualFolderId: assignment || null,
  };
}

/** 统一的分页切片：永远显式回 total / offset / limit / truncated。 */
function paginate(list, pagination) {
  const items = Array.isArray(list) ? list : [];
  const { offset, limit } = pagination;
  const slice = items.slice(offset, offset + limit);
  return { items: slice, total: items.length, offset, limit, truncated: offset + slice.length < items.length };
}

/** 源 photoLibraryIndex.ts:41-45：图库条目视图。 */
function libraryItemView(entry) {
  return {
    node: {
      id: entry.node.id,
      name: entry.node.name,
      type: "file",
      parentId: entry.node.parentId == null ? null : entry.node.parentId,
      mime: entry.node.mime == null ? null : String(entry.node.mime),
      size: Number(entry.node.size) || 0,
      created_ts: Number(entry.node.created_ts) || 0,
      updated_ts: Number(entry.node.updated_ts) || 0,
    },
    folderId: entry.folderId == null ? null : entry.folderId,
    folderName: entry.folderName,
    path: entry.path,
    kind: entry.kind,
  };
}

/** 源 photoLibraryIndex.ts:50-63：share 优先按 canSeeShare，其次要求 ownerId 为空或本人。 */
function libraryEntryVisible(entry, userId, canSeeShare) {
  if (entry.share) {
    try {
      return !!(canSeeShare && canSeeShare(entry.share));
    } catch {
      return false;
    }
  }
  return !entry.ownerId || entry.ownerId === userId;
}

// ---------------------------------------------------------------------------
// 相关推荐打分（源 photoSourceVisualFeatures.ts:76-123 逐字移植）
// ---------------------------------------------------------------------------

function visualSimilarity(a, b) {
  let color = 0;
  let saturation = 0;
  let texture = 0;
  let outline = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const delta = a[i] - b[i];
    if (i >= 80) outline += delta * delta;
    else if (i % 5 < 3) color += delta * delta;
    else if (i % 5 === 3) saturation += delta * delta;
    else texture += delta * delta;
  }
  return 1 / (1 + 4 * (2 * color / 48 + 0.3 * saturation / 16 + 0.2 * texture / 16 + 0.15 * outline / 112));
}

/**
 * 源 :114-119：语义分 >= 0.12 时以文本为主，否则以视觉为主；同文件夹 +0.025。
 * semanticCount 对应源里的 semantic.size —— 有语义条目时视觉权重降到 0.18，
 * 否则视觉分单独决定排序（0.95）。
 */
function relatedScore(reference, features, semanticText, sameFolder, semanticCount = 0) {
  const visual = visualSimilarity(reference, features);
  const text = Number.isFinite(semanticText) ? semanticText : 0;
  if (text >= 0.12) return 0.55 + text * 0.4 + visual * 0.05 + sameFolder;
  return visual * (Number(semanticCount) > 0 ? 0.18 : 0.95) + sameFolder;
}

/** 源 :59-60：签名哈希口径。 */
function signatureHash(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

// ---------------------------------------------------------------------------
// 字节出口（源 ocr-service.cjs:259-263 / media-service.cjs:367-369 同一口径）
// ---------------------------------------------------------------------------

/** base64url 不含 '/'，绕开 foundation 的绝对路径替换，避免图片字节被误脱敏。 */
function encodePhotoBytes(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

module.exports = {
  PHOTO_IMAGE_TYPES,
  PHOTO_VIDEO_TYPES,
  LIBRARY_IMAGE_EXTENSIONS,
  LIBRARY_VIDEO_EXTENSIONS,
  PHOTOS_DIR_NAME,
  PHOTOS_SOURCES_SHARED_FILE,
  PHOTOS_SOURCES_LEGACY_RE,
  PHOTOS_MAX_FOLDER_NAME_LENGTH,
  PHOTOS_MAX_WALK_DEPTH,
  PHOTOS_MAX_INDEX_ITEMS,
  PHOTOS_LOCAL_PREFIX,
  PHOTOS_DESKTOP_LABEL,
  PHOTOS_FEATURE_VECTOR_LENGTH,
  PHOTOS_MAX_FEATURE_BATCH,
  PHOTOS_MAX_SIGNATURE_LENGTH,
  PHOTOS_MAX_RANKED_IDS,
  PHOTOS_MAX_ID_LENGTH,
  PHOTOS_MAX_ASSIGN_IDS,
  PHOTOS_PAGE_LIMIT_DEFAULT,
  PHOTOS_PAGE_LIMIT_MAX,

  PHOTOS_ERR_COMMAND_NOT_ALLOWED,
  PHOTOS_ERR_NOT_READY,
  PHOTOS_ERR_INVALID_INPUT,
  PHOTOS_ERR_UNAUTHENTICATED,
  PHOTOS_ERR_FORBIDDEN,
  PHOTOS_ERR_NOT_FOUND,
  PHOTOS_ERR_CONFLICT,
  PHOTOS_ERR_PATH_ESCAPE,
  PHOTOS_ERR_TOO_LARGE,
  PHOTOS_ERR_DEPENDENCY_UNAVAILABLE,
  PHOTOS_ERR_PROVIDER_UNAVAILABLE,
  PHOTOS_ERR_PROVIDER_FAILED,
  PHOTOS_ERR_INTERNAL,
  PHOTOS_ERROR_CODES,

  createPhotosError,
  isPhotosError,
  normalizePhotosError,
  toPhotosIpcResult,
  photosCommandNotAllowed,

  PHOTOS_COMMANDS,
  isPhotosCommand,
  photosCommandEntry,
  listPhotosCommands,

  isPlainObject,
  clipText,
  isContainedPath,
  photosUserFileHash,
  photosUserFileName,
  photosMimeForName,
  photosKindForMime,
  classifyLibraryNode,

  normalizeSourcePath,
  requireId,
  normalizeFolderName,
  normalizeOptionalParentId,
  normalizeAssignIds,
  normalizePagination,
  parseLocalPhotoId,
  isValidFeatureVector,
  normalizeFeatureItem,
  normalizeFeatureQueryItems,
  normalizeFeatureWriteItems,
  normalizeRelatedKey,
  normalizeRelatedCandidate,
  normalizeSemanticEntries,

  photoItemView,
  paginate,
  libraryItemView,
  libraryEntryVisible,
  visualSimilarity,
  relatedScore,
  signatureHash,
  encodePhotoBytes,
};
