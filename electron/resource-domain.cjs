/**
 * D3-04A · Resource Store —— 纯领域模型。
 *
 * 与 identity-domain / authorization-domain 同一约束：**纯函数、无 Electron、无 DOM、
 * 无 I/O**，因此能被 node --test 直接覆盖。
 *
 * 三条不可动摇的分层：
 *   ① resource_registry（D3-02）继续是**逻辑身份 / 授权权威**。
 *      本模块不创建第二身份系统；library_resources 只承载存储语义。
 *   ② DB 与文件系统之间**没有真正的 ACID**。导入必须走显式状态机 + 可重放 recovery，
 *      文档与代码都不得声称 "DB + filesystem atomic transaction"。
 *   ③ 渲染进程拿不到绝对路径 / source locator：只拿到 ResourceRef、safe metadata、availability。
 */
"use strict";

const crypto = require("node:crypto");
const authz = require("./authorization-domain.cjs");

// ---------------------------------------------------------------------------
// 枚举
// ---------------------------------------------------------------------------

const STORAGE_MODE = Object.freeze({ MANAGED: "MANAGED", LINKED: "LINKED" });
const STORAGE_MODES = Object.freeze([STORAGE_MODE.MANAGED, STORAGE_MODE.LINKED]);

/** library_resources.trash_state。Trash 是**存储语义**，不是授权身份。 */
const TRASH_STATE = Object.freeze({ ACTIVE: "ACTIVE", TRASHED: "TRASHED" });

/** content_objects.status。OBJECT_READY 才可被读取；GC_PENDING 只是回收候选。 */
const CONTENT_STATUS = Object.freeze({
  OBJECT_READY: "OBJECT_READY",
  GC_PENDING: "GC_PENDING",
  DELETED: "DELETED",
});

/**
 * Import 状态机。每个失败点都必须能被 recovery 解释或清理。
 * COMMITTING 是"DB 事务已开始但尚未提交"的显式阶段，不是隐式的。
 */
const IMPORT_PHASE = Object.freeze({
  STAGING: "STAGING",
  HASHED: "HASHED",
  OBJECT_READY: "OBJECT_READY",
  COMMITTING: "COMMITTING",
  AVAILABLE: "AVAILABLE",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
  ORPHANED: "ORPHANED",
});
const TERMINAL_IMPORT_PHASES = Object.freeze([IMPORT_PHASE.AVAILABLE, IMPORT_PHASE.FAILED, IMPORT_PHASE.CANCELLED, IMPORT_PHASE.ORPHANED]);

const SOURCE = Object.freeze({ USER: "user", IMPORT: "import", AGENT: "agent", SYSTEM: "system", GENERATED: "generated" });

const INDEX_STATUS = Object.freeze({ NOT_INDEXED: "NOT_INDEXED", PENDING: "PENDING", INDEXED: "INDEXED", FAILED: "FAILED" });

const RELATION_TYPE = Object.freeze({
  REFERENCES: "references",
  DERIVED_FROM: "derived-from",
  GENERATED_FROM: "generated-from",
});
const RELATION_TYPES = Object.freeze(Object.values(RELATION_TYPE));

/** Tag 来源：user / system / agent。系统 Tag 语义普通用户不得随意修改。 */
const TAG_SOURCE = Object.freeze({ USER: "user", SYSTEM: "system", AGENT: "agent" });
const TAG_SOURCES = Object.freeze(Object.values(TAG_SOURCE));
const MAX_TAG_LENGTH = 64;
const MAX_TAG_COUNT_PER_RESOURCE = 64;

/**
 * Memory subtype 是 Resource metadata 分类，**不是** Resource Type。
 * Resource Type 仍是 memory；这里只细分用途。
 */
const MEMORY_SUBTYPE = Object.freeze({
  PERSONAL_PREFERENCE: "personal-preference",
  PROJECT_MEMORY: "project-memory",
  DECISION_MEMORY: "decision-memory",
  CONVERSATION_MEMORY: "conversation-memory",
  AGENT_MEMORY: "agent-memory",
});
const MEMORY_SUBTYPES = Object.freeze(Object.values(MEMORY_SUBTYPE));

/** 导航分类 → resourceType 集合。分类映射在 Domain 冻结，Renderer 不按扩展名猜。 */
const CATEGORY = Object.freeze({
  ALL: "all",
  MEMORY: "memory",
  DOCUMENTS: "documents",
  IMAGES: "images",
  VIDEOS: "videos",
  AUDIO: "audio",
  CODE: "code",
  PROMPTS: "prompts",
  GENERATED: "generated",
  FAVORITES: "favorites",
  RECENT: "recent",
  TRASH: "trash",
});
const CATEGORY_TYPES = Object.freeze({
  [CATEGORY.MEMORY]: Object.freeze(["memory"]),
  [CATEGORY.DOCUMENTS]: Object.freeze(["text", "document", "file"]),
  [CATEGORY.IMAGES]: Object.freeze(["image"]),
  [CATEGORY.VIDEOS]: Object.freeze(["video"]),
  [CATEGORY.AUDIO]: Object.freeze(["audio"]),
  [CATEGORY.CODE]: Object.freeze(["code"]),
  [CATEGORY.PROMPTS]: Object.freeze(["prompt"]),
  [CATEGORY.GENERATED]: Object.freeze(["generated-artifact"]),
});

const SORT_FIELDS = Object.freeze(["name", "created", "updated", "size"]);
const SORT_DIRECTIONS = Object.freeze(["asc", "desc"]);
const DEFAULT_PAGE_LIMIT = 60;
const MAX_PAGE_LIMIT = 500;

/**
 * 资源可用性。**必须诚实**：源文件丢了就是 SOURCE_MISSING，设备离线就是 DEVICE_OFFLINE，
 * 不允许伪装成 AVAILABLE。
 */
const AVAILABILITY = Object.freeze({
  AVAILABLE: "AVAILABLE",
  SOURCE_MISSING: "SOURCE_MISSING",
  SOURCE_CHANGED: "SOURCE_CHANGED",
  DEVICE_OFFLINE: "DEVICE_OFFLINE",
  DEVICE_REVOKED: "DEVICE_REVOKED",
  DEVICE_DISABLED: "DEVICE_DISABLED",
  DEVICE_UNKNOWN: "DEVICE_UNKNOWN",
  INTEGRITY_FAILED: "INTEGRITY_FAILED",
  TRASHED: "TRASHED",
  UNKNOWN: "UNKNOWN",
});

/** MANAGED Store 位于当前 Control Service / local storage device。 */
const LOCAL_DEVICE_ID = "local";

const REASON = Object.freeze({
  INVALID_INPUT: "INVALID_INPUT",
  NOT_FOUND_OR_FORBIDDEN: "NOT_FOUND_OR_FORBIDDEN",
  RESOURCE_TRASHED: "RESOURCE_TRASHED",
  VERSION_CONFLICT: "VERSION_CONFLICT",
  SOURCE_MISSING: "SOURCE_MISSING",
  SOURCE_CHANGED: "SOURCE_CHANGED",
  SOURCE_NOT_REGULAR: "SOURCE_NOT_REGULAR",
  SOURCE_UNREADABLE: "SOURCE_UNREADABLE",
  LINKED_SYMLINK_REJECTED: "LINKED_SYMLINK_REJECTED",
  DEVICE_OFFLINE: "DEVICE_OFFLINE",
  DEVICE_REVOKED: "DEVICE_REVOKED",
  DEVICE_DISABLED: "DEVICE_DISABLED",
  DEVICE_UNKNOWN: "DEVICE_UNKNOWN",
  DISK_SPACE_INSUFFICIENT: "DISK_SPACE_INSUFFICIENT",
  ENOSPC: "ENOSPC",
  CHECKSUM_MISMATCH: "CHECKSUM_MISMATCH",
  OBJECT_MISSING: "OBJECT_MISSING",
  OBJECT_SIZE_MISMATCH: "OBJECT_SIZE_MISMATCH",
  IMPORT_CANCELLED: "IMPORT_CANCELLED",
  IMPORT_FAILED: "IMPORT_FAILED",
  CONTENT_OBJECT_UNKNOWN: "CONTENT_OBJECT_UNKNOWN",
  CONTENT_TOO_LARGE: "CONTENT_TOO_LARGE",
  REMOTE_DEVICE_CONTENT_UNSUPPORTED: "REMOTE_DEVICE_CONTENT_UNSUPPORTED",
  STORAGE_MODE_INVALID: "STORAGE_MODE_INVALID",
  PATH_ESCAPE: "PATH_ESCAPE",
  RELATION_UNKNOWN: "RELATION_UNKNOWN",
  NO_CHANGE: "NO_CHANGE",
  INTERNAL_ERROR: "INTERNAL_ERROR",
});

const MAX_READ_TEXT_BYTES = 8 * 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CONTENT_ID_PREFIX = "co_";
const VERSION_ID_PREFIX = "ver_";
const IMPORT_JOB_PREFIX = "imp_";
const RELATION_ID_PREFIX = "rel_";

const ok = (value) => ({ ok: true, ...(value || {}) });
const fail = (code, detail) => ({ ok: false, error: code, ...(detail ? { detail } : {}) });

// ---------------------------------------------------------------------------
// ID / content addressing
// ---------------------------------------------------------------------------

function newVersionId() {
  return VERSION_ID_PREFIX + crypto.randomBytes(18).toString("base64url");
}
function newImportJobId() {
  return IMPORT_JOB_PREFIX + crypto.randomBytes(18).toString("base64url");
}
function newRelationId() {
  return RELATION_ID_PREFIX + crypto.randomBytes(18).toString("base64url");
}

const isSha256Hex = (v) => typeof v === "string" && SHA256_PATTERN.test(v);

/** contentId 由 checksum 确定性派生：同一内容无论导入多少次都是同一个 id（dedupe）。 */
const contentIdFor = (checksum) => CONTENT_ID_PREFIX + checksum;

/**
 * 内容对象的内部 key **只由 OpenArc 从 checksum 生成**。
 * 用户文件名、用户路径、显示名永不参与最终位置 —— 从设计上消除 traversal 输入。
 * 形式：objects/sha256/ab/<64 hex>
 */
function contentInternalKey(checksum, algorithm = "sha256") {
  if (algorithm !== "sha256" || !isSha256Hex(checksum)) return null;
  return "objects/sha256/" + checksum.slice(0, 2) + "/" + checksum;
}

/** staging key 只由 jobId 生成。 */
function stagingKeyFor(jobId) {
  const safe = String(jobId || "").replace(/[^A-Za-z0-9_-]/g, "");
  if (!safe) return null;
  return "staging/" + safe + ".part";
}

/** 目录分隔统一成正斜杠，供 DB 内部 key 使用（跨平台可解释）。 */
const toInternalKey = (value) => String(value || "").replace(/\\/g, "/").replace(/^\/+/, "");

/**
 * 纯字符串版的"是否在 store 内"。真正的写入路径还会再做 realpath 校验。
 * 拒绝 .. 穿越、绝对路径、以及任何 resolve 后逃出 root 的情况。
 */
function isPathInside(root, candidate) {
  if (!root || !candidate) return false;
  const path = require("node:path");
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function assertInsideStore(root, candidate) {
  return isPathInside(root, candidate) ? ok({ path: candidate }) : fail(REASON.PATH_ESCAPE);
}

/** 拒绝明显的 traversal 片段（defense-in-depth；最终仍以 realpath 判定为准）。 */
function hasTraversal(value) {
  const s = String(value || "");
  return s.includes("..") || s.includes("\u0000");
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

function validateStorageMode(mode) {
  if (!STORAGE_MODES.includes(String(mode || ""))) return fail(REASON.STORAGE_MODE_INVALID);
  return ok({ storageMode: String(mode) });
}

function validateRelationType(type) {
  if (!RELATION_TYPES.includes(String(type || ""))) return fail(REASON.RELATION_UNKNOWN);
  return ok({ relationType: String(type) });
}

/** 资源类型继续复用 D3-02 的单一清单，避免两套类型系统分叉。 */
function validateResourceType(type) {
  return authz.validateResourceType(type);
}

/** 乐观并发：expectedVersion 与当前 version 不一致即拒绝，不静默覆盖。 */
function evaluateVersionConflict({ expectedVersion = null, currentVersion } = {}) {
  if (expectedVersion == null) return ok({ checked: false });
  const expected = Number(expectedVersion);
  const current = Number(currentVersion);
  if (!Number.isInteger(expected) || expected < 1) return fail(REASON.INVALID_INPUT);
  if (expected !== current) return { ok: false, error: REASON.VERSION_CONFLICT, expected, current };
  return ok({ checked: true, version: current });
}

const nextVersion = (current) => Number(current || 0) + 1;

// ---------------------------------------------------------------------------
// MIME（基础 sniffing，不引入巨型媒体识别系统）
// ---------------------------------------------------------------------------

const TEXT_EXTENSIONS = Object.freeze(["txt", "md", "markdown", "json", "js", "mjs", "cjs", "ts", "tsx", "css", "html", "xml", "yml", "yaml", "csv", "log", "sh", "py", "rb", "go", "rs", "java", "c", "h", "cpp"]);
const EXTENSION_MIME = Object.freeze({
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  json: "application/json",
  js: "text/javascript",
  mjs: "text/javascript",
  ts: "text/plain",
  tsx: "text/plain",
  css: "text/css",
  html: "text/html",
  xml: "application/xml",
  yml: "application/yaml",
  yaml: "application/yaml",
  csv: "text/csv",
  log: "text/plain",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  zip: "application/zip",
  prompt: "text/plain",
});

function extensionOf(filename) {
  const s = String(filename || "");
  const idx = s.lastIndexOf(".");
  if (idx < 0 || idx === s.length - 1) return "";
  return s.slice(idx + 1).toLowerCase();
}

const startsWith = (buf, bytes) => bytes.every((b, i) => buf[i] === b);

/**
 * 基础 MIME sniffing：magic bytes 优先，扩展名只作补充。
 * **不只相信 extension**（§32），但也不为此引入庞大的媒体识别系统。
 */
function sniffMime(head, filename) {
  const buf = Buffer.isBuffer(head) ? head : Buffer.from(head || []);
  const ext = extensionOf(filename);
  if (buf.length >= 8 && startsWith(buf, [0x89, 0x50, 0x4e, 0x47])) return "image/png";
  if (buf.length >= 3 && startsWith(buf, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (buf.length >= 6 && buf.slice(0, 3).toString("ascii") === "GIF") return "image/gif";
  if (buf.length >= 12 && buf.slice(0, 4).toString("ascii") === "RIFF" && buf.slice(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (buf.length >= 5 && buf.slice(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  if (buf.length >= 4 && startsWith(buf, [0x50, 0x4b, 0x03, 0x04])) return EXTENSION_MIME[ext] || "application/zip";
  if (buf.length >= 12 && buf.slice(4, 8).toString("ascii") === "ftyp") return "video/mp4";
  if (buf.length >= 12 && buf.slice(0, 4).toString("ascii") === "OggS") return "audio/ogg";
  if (buf.length >= 3 && buf.slice(0, 3).toString("ascii") === "ID3") return "audio/mpeg";
  if (EXTENSION_MIME[ext]) return EXTENSION_MIME[ext];
  if (TEXT_EXTENSIONS.includes(ext)) return "text/plain";
  return "application/octet-stream";
}

// ---------------------------------------------------------------------------
// 安全投影
// ---------------------------------------------------------------------------

/**
 * 渲染进程可见的 descriptor。**白名单**，不含 source_locator / 绝对路径 / 内部 key。
 * 需要显示来源时由 presentSource 给一句人话，而不是把路径发出去。
 */
function descriptorProjection(row, { availability = null, favorite = false, recentAt = null } = {}) {
  if (!row) return null;
  let attributes = {};
  try {
    attributes = typeof row.attributes === "string" ? JSON.parse(row.attributes || "{}") : row.attributes || {};
  } catch {
    attributes = {};
  }
  return {
    resourceId: row.resource_id,
    resourceRef: authz.toResourceRef(row.resource_id),
    resourceType: row.resource_type,
    mimeType: row.mime_type,
    name: row.name,
    description: row.description,
    storageMode: row.storage_mode,
    size: row.size == null ? null : Number(row.size),
    checksum: row.checksum || null,
    version: Number(row.version || 1),
    scope: row.scope ?? null,
    departmentId: row.department_id ?? null,
    collectionId: row.collection_id ?? null,
    ownerUserId: row.owner_user_id ?? null,
    storageDeviceId: row.storage_device_id ?? null,
    memorySubtype: row.memory_subtype ?? null,
    language: row.language ?? null,
    attributes,
    favorite: !!favorite,
    recentAt: recentAt == null ? null : Number(recentAt),
    indexStatus: row.index_status || INDEX_STATUS.NOT_INDEXED,
    trashed: row.trash_state === TRASH_STATE.TRASHED,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at ?? null,
    availability: availability || (row.trash_state === TRASH_STATE.TRASHED ? AVAILABILITY.TRASHED : AVAILABILITY.UNKNOWN),
  };
}

/** 给人看的来源描述：绝不含绝对路径。 */
function presentSource({ storageMode, storageDeviceId } = {}) {
  if (storageMode === STORAGE_MODE.MANAGED) return { kind: "managed", label: "已复制到 OpenArc", deviceId: storageDeviceId || LOCAL_DEVICE_ID };
  if (storageMode === STORAGE_MODE.LINKED) {
    const local = !storageDeviceId || storageDeviceId === LOCAL_DEVICE_ID;
    return { kind: "linked", label: local ? "链接在本机" : "链接在设备 " + storageDeviceId, deviceId: storageDeviceId || LOCAL_DEVICE_ID };
  }
  return { kind: "unknown", label: "未知来源", deviceId: storageDeviceId || null };
}

/** 审计 / 落盘前统一裁掉 secret 类键与超长值（§76）。 */
const FORBIDDEN_METADATA_KEYS = Object.freeze(["token", "sessionToken", "apiKey", "apikey", "api_key", "privateKey", "devicePrivateKey", "secret", "password", "credential", "authorization"]);
function sanitizeMetadata(input = {}) {
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    const flat = k.toLowerCase().replace(/[^a-z]/g, "");
    if (FORBIDDEN_METADATA_KEYS.some((f) => flat === f.toLowerCase().replace(/[^a-z]/g, ""))) continue;
    if (v == null) continue;
    out[k] = typeof v === "string" ? v.slice(0, 200) : v;
  }
  return out;
}

/** 设备状态 → 资源可用性（D3-03 的 resolveResourceLocation 输出）。 */
function availabilityFromDevice(location) {
  if (!location) return AVAILABILITY.DEVICE_UNKNOWN;
  if (location.status === "REVOKED") return AVAILABILITY.DEVICE_REVOKED;
  if (location.status === "DISABLED") return AVAILABILITY.DEVICE_DISABLED;
  if (location.status && location.status !== "ACTIVE") return AVAILABILITY.DEVICE_UNKNOWN;
  if (location.connectivity === "OFFLINE") return AVAILABILITY.DEVICE_OFFLINE;
  return null;
}

// ---------------------------------------------------------------------------
// D3-04B · Tag / Memory / 分类 / 排序 校验（纯函数）
// ---------------------------------------------------------------------------

/**
 * Tag 规范化（冻结）：
 *   - trim + 连续空白折叠为单个空格；显示名保留大小写；
 *   - 比较使用 normalized form（小写），因此 Shoes == shoes；
 *   - 空 / 超长 / 控制字符拒绝。
 */
function normalizeTagName(raw) {
  const name = String(raw == null ? "" : raw)
    .trim()
    .replace(/\s+/g, " ");
  if (!name) return fail(REASON.INVALID_INPUT, "tag-empty");
  if (name.length > MAX_TAG_LENGTH) return fail(REASON.INVALID_INPUT, "tag-too-long");
  if (/[\u0000-\u001f\u007f]/.test(name)) return fail(REASON.INVALID_INPUT, "tag-control-char");
  return ok({ name, normalizedName: name.toLowerCase() });
}

function validateTagSource(source) {
  const s = String(source == null ? TAG_SOURCE.USER : source);
  if (!TAG_SOURCES.includes(s)) return fail(REASON.INVALID_INPUT, "tag-source");
  return ok({ source: s });
}

/** memory subtype 可空；非空必须是冻结集合之一。 */
function validateMemorySubtype(value) {
  if (value == null || value === "") return ok({ memorySubtype: null });
  const v = String(value);
  if (!MEMORY_SUBTYPES.includes(v)) return fail(REASON.INVALID_INPUT, "memory-subtype");
  return ok({ memorySubtype: v });
}

function normalizeSort({ sort = "updated", direction = "desc" } = {}) {
  const field = String(sort || "updated");
  const dir = String(direction || "desc").toLowerCase();
  if (!SORT_FIELDS.includes(field)) return fail(REASON.INVALID_INPUT, "sort-field");
  if (!SORT_DIRECTIONS.includes(dir)) return fail(REASON.INVALID_INPUT, "sort-direction");
  return ok({ sort: field, direction: dir });
}

function normalizePage({ limit = DEFAULT_PAGE_LIMIT, offset = 0 } = {}) {
  const l = Number(limit);
  const o = Number(offset);
  if (!Number.isInteger(l) || l < 1) return fail(REASON.INVALID_INPUT, "limit");
  if (!Number.isFinite(o) || o < 0) return fail(REASON.INVALID_INPUT, "offset");
  return ok({ limit: Math.min(l, MAX_PAGE_LIMIT), offset: Math.floor(o) });
}

/** 分类 → resourceType 集合；ALL/FAVORITES/RECENT/TRASH 返回 null（由查询语义处理）。 */
function categoryTypes(category) {
  return CATEGORY_TYPES[String(category || "")] || null;
}

module.exports = {
  STORAGE_MODE,
  STORAGE_MODES,
  TRASH_STATE,
  CONTENT_STATUS,
  IMPORT_PHASE,
  TERMINAL_IMPORT_PHASES,
  SOURCE,
  INDEX_STATUS,
  RELATION_TYPE,
  RELATION_TYPES,
  TAG_SOURCE,
  TAG_SOURCES,
  MAX_TAG_LENGTH,
  MAX_TAG_COUNT_PER_RESOURCE,
  MEMORY_SUBTYPE,
  MEMORY_SUBTYPES,
  CATEGORY,
  CATEGORY_TYPES,
  SORT_FIELDS,
  SORT_DIRECTIONS,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  AVAILABILITY,
  LOCAL_DEVICE_ID,
  REASON,
  MAX_READ_TEXT_BYTES,
  SHA256_PATTERN,
  CONTENT_ID_PREFIX,
  ok,
  fail,
  newVersionId,
  newImportJobId,
  newRelationId,
  isSha256Hex,
  contentIdFor,
  contentInternalKey,
  stagingKeyFor,
  toInternalKey,
  isPathInside,
  assertInsideStore,
  hasTraversal,
  validateStorageMode,
  validateRelationType,
  validateResourceType,
  evaluateVersionConflict,
  nextVersion,
  extensionOf,
  sniffMime,
  descriptorProjection,
  normalizeTagName,
  validateTagSource,
  validateMemorySubtype,
  normalizeSort,
  normalizePage,
  categoryTypes,
  presentSource,
  sanitizeMetadata,
  availabilityFromDevice,
};
