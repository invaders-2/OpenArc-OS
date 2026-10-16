/**
 * 文件传输域 · 纯逻辑层（**无 I/O，无 Electron**）。
 *
 * 逐函数移植自只读源（行号为源文件行号）：
 *   · server/fileTransfers.ts:6-8        TRANSFER_CHUNK_BYTES / TRANSFER_MAX_BYTES / TTL
 *   · server/fileTransfers.ts:14         failure(message, status) → 本文件 transferFailure
 *   · server/fileTransfers.ts:28         view（只回不透明 id，绝不回宿主路径）
 *   · server/fileTransfers.ts:33-35      配额口径（own 数量 / own 字节 / 全局保留 / 会话数）
 *   · server/fileTransfers.ts:51         chunk 形状校验（offset / length / 单块上限 / 越界 / 封存）
 *   · server/fileTransfers.ts:74         complete 的 SHA-256 形状校验
 *   · server/fileTransferRoutes.ts:32-37 begin 入参：kind 枚举 / preview 16MiB / name 清洗
 *
 * 为什么单独一层：fileTransfer:command 是新增顶层 IPC 通道，"可调用哪些命令、入参怎么归一、
 * 路径怎么围栏、失败回什么码"必须先在一处冻结，再交给 file-transfer-service.cjs 落盘、
 * file-transfer-bootstrap.cjs 注册。命令表本身即白名单，未登记命令一律
 * FILE_TRANSFER_COMMAND_NOT_ALLOWED，不做动态 dispatch。
 *
 * 刻意排除（与任务书约束一致，出现即拒绝而不是静默忽略）：
 *   · 云能力（cloudAccount / 云 AI / 云端市场 / api.dx-os.com / 计费配额）——一个字段都不接收；
 *   · 源 fileTransferRoutes.ts:32 的 purpose === 'photocraft-save' 门禁：OpenArc 没有 photocraft
 *     项目域，源 fileTransferRoutes.ts:35-36 的 revision 校验也随之没有本地对端。这里只把
 *     revision 作为 scope 的结构化整数保留（见 normalizeTransferScope），不伪造"版本已变化"判定；
 *   · 源 fileTransferRoutes.ts:52-60 的 /save-bundle 是 photocraft 专属消费者，不在 5 条路由内，
 *     不移植；transfers.use 仍按源 fileTransfers.ts:88-98 保留在 service 供主进程内部消费。
 */
"use strict";

const path = require("node:path");
const foundationErrors = require("./dxos-foundation-errors.cjs");

// ---------------------------------------------------------------------------
// 常量（源 server/fileTransfers.ts:6-8、server/fileTransferRoutes.ts:33）
// ---------------------------------------------------------------------------

/** 源 fileTransfers.ts:6。 */
const TRANSFER_CHUNK_BYTES = 4 * 1024 * 1024;
/** 源 fileTransfers.ts:7。 */
const TRANSFER_MAX_BYTES = 8 * 1024 * 1024 * 1024;
/** 源 fileTransfers.ts:8 TTL = 24h（源未导出，这里导出是为了让测试与配置能引用同一口径）。 */
const TRANSFER_TTL_MS = 24 * 60 * 60 * 1000;
/** 源 fileTransferRoutes.ts:33：preview（项目预览）单文件上限。 */
const PREVIEW_MAX_BYTES = 16 * 1024 * 1024;
/** 源 fileTransferRoutes.ts:32：kind 枚举。 */
const TRANSFER_KINDS = Object.freeze(["source", "preview"]);
/** 源 fileTransfers.ts:35：同一 owner 的活跃会话数与字节上限。 */
const TRANSFER_MAX_OWNED = 4;
const TRANSFER_MAX_OWNER_BYTES = TRANSFER_MAX_BYTES * 2;
const TRANSFER_MAX_RESERVED_BYTES = TRANSFER_MAX_BYTES * 4;
const TRANSFER_MAX_SESSIONS = 128;
/** 源 fileTransfers.ts:37：暂存文件后缀（<id>.part）。 */
const TRANSFER_STAGING_SUFFIX = ".part";
/**
 * 源 fileTransferRoutes.ts:41：源按 kind 硬编码 mime（preview → image/png，source → Photoshop）。
 * OpenArc 的文件传输是通用数据面，不再是 photocraft 专属，所以允许调用方显式给 mime；
 * 缺省时回落到源里的同一对取值，保持语义可比。
 */
const TRANSFER_DEFAULT_MIME = Object.freeze({ source: "image/vnd.adobe.photoshop", preview: "image/png" });

// ---------------------------------------------------------------------------
// 错误规约（与 MEDIA_* / DEVELOPER_* 同形：域自有码，不并进 DXOS_*）
// ---------------------------------------------------------------------------

const FILE_TRANSFER_ERR_COMMAND_NOT_ALLOWED = "FILE_TRANSFER_COMMAND_NOT_ALLOWED";
const FILE_TRANSFER_ERR_INVALID_INPUT = "FILE_TRANSFER_INVALID_INPUT";
const FILE_TRANSFER_ERR_UNAUTHENTICATED = "FILE_TRANSFER_UNAUTHENTICATED";
const FILE_TRANSFER_ERR_NOT_FOUND = "FILE_TRANSFER_NOT_FOUND";
const FILE_TRANSFER_ERR_CONFLICT = "FILE_TRANSFER_CONFLICT";
const FILE_TRANSFER_ERR_QUOTA_EXCEEDED = "FILE_TRANSFER_QUOTA_EXCEEDED";
const FILE_TRANSFER_ERR_PATH_ESCAPE = "FILE_TRANSFER_PATH_ESCAPE";
const FILE_TRANSFER_ERR_NOT_READY = "FILE_TRANSFER_NOT_READY";
const FILE_TRANSFER_ERR_INTERNAL = "FILE_TRANSFER_INTERNAL";

const FILE_TRANSFER_ERROR_CODES = Object.freeze([
  FILE_TRANSFER_ERR_COMMAND_NOT_ALLOWED,
  FILE_TRANSFER_ERR_INVALID_INPUT,
  FILE_TRANSFER_ERR_UNAUTHENTICATED,
  FILE_TRANSFER_ERR_NOT_FOUND,
  FILE_TRANSFER_ERR_CONFLICT,
  FILE_TRANSFER_ERR_QUOTA_EXCEEDED,
  FILE_TRANSFER_ERR_PATH_ESCAPE,
  FILE_TRANSFER_ERR_NOT_READY,
  FILE_TRANSFER_ERR_INTERNAL,
]);

/**
 * 源 fileTransfers.ts:14 用 HTTP status 表达失败（400/404/409/429/500）；
 * IPC 没有 status，这里保留 status 字段用于追溯，同时折算成稳定域错误码。
 */
const TRANSFER_STATUS_CODE = Object.freeze({
  400: FILE_TRANSFER_ERR_INVALID_INPUT,
  404: FILE_TRANSFER_ERR_NOT_FOUND,
  409: FILE_TRANSFER_ERR_CONFLICT,
  429: FILE_TRANSFER_ERR_QUOTA_EXCEEDED,
  500: FILE_TRANSFER_ERR_INTERNAL,
});

function transferStatusCode(status) {
  return TRANSFER_STATUS_CODE[status] || FILE_TRANSFER_ERR_INTERNAL;
}

/** 构造带稳定 code 的传输域错误；message 过 foundation 的 redactText（不回宿主路径）。 */
function createFileTransferError(code, message, detail) {
  const err = new Error(foundationErrors.redactText(message == null ? code : message));
  err.name = "FileTransferError";
  err.code = FILE_TRANSFER_ERROR_CODES.includes(code) ? code : FILE_TRANSFER_ERR_INTERNAL;
  if (detail !== undefined) err.detail = foundationErrors.redactValue(detail);
  return err;
}

/** 源 fileTransfers.ts:14 failure 的等价物：同一处把 status 折算成域码。 */
function transferFailure(status, message) {
  const err = createFileTransferError(transferStatusCode(status), message);
  err.status = status;
  return err;
}

function isFileTransferError(err) {
  return !!err && typeof err === "object" && typeof err.code === "string" && FILE_TRANSFER_ERROR_CODES.includes(err.code);
}

/** 渲染层出口：成功 { ok:true, value }；失败 normalizeFileTransferError（与 foundation.toIpcResult 同形）。 */
function redactFileTransferValue(value) {
  return foundationErrors.redactValue(value);
}

function normalizeFileTransferError(err) {
  if (isFileTransferError(err)) {
    const out = { ok: false, error: err.code, message: foundationErrors.redactText(err.message || err.code) || err.code };
    if (typeof err.status === "number") out.status = err.status;
    if (err.detail !== undefined) out.detail = foundationErrors.redactValue(err.detail);
    return out;
  }
  return foundationErrors.normalizeError(err, { fallbackCode: foundationErrors.DXOS_ERR_INTERNAL });
}

async function toFileTransferIpcResult(action) {
  try {
    const value = typeof action === "function" ? await action() : await action;
    return { ok: true, value: redactFileTransferValue(value) };
  } catch (err) {
    return normalizeFileTransferError(err);
  }
}

function fileTransferCommandNotAllowed(command) {
  return createFileTransferError(
    FILE_TRANSFER_ERR_COMMAND_NOT_ALLOWED,
    "未知或未授权的 fileTransfer 命令：" + String(command == null ? "" : command),
    { command: command == null ? null : String(command) },
  );
}

// ---------------------------------------------------------------------------
// 命令白名单（顶层 IPC 面；risk/summary 供 UI 与审计）
// ---------------------------------------------------------------------------

const FILE_TRANSFER_COMMANDS = Object.freeze({
  "fileTransfer/begin": { risk: "manage", summary: "开始一次分片传输（校验 size / kind / scope，预占配额并建 <id>.part）" },
  "fileTransfer/chunk": { risk: "manage", summary: "顺序写入一个文件块（offset 必须等于当前进度，可带块 SHA-256 校验）" },
  "fileTransfer/complete": { risk: "manage", summary: "封存传输并做整文件 SHA-256 校验（未传满即拒绝）" },
  "fileTransfer/status": { risk: "read", summary: "查询单个传输的进度 / 过期时间 / 已校验哈希" },
  "fileTransfer/cancel": { risk: "destructive", summary: "取消传输并删除暂存文件" },
  "fileTransfer/cleanup": { risk: "destructive", summary: "显式回收过期会话与孤儿暂存文件（防无限增长）" },
  "fileTransfer/health": { risk: "read", summary: "文件传输域状态（会话数 / 在途 / 过期，不含宿主路径）" },
});

function isFileTransferCommand(command) {
  return typeof command === "string" && Object.prototype.hasOwnProperty.call(FILE_TRANSFER_COMMANDS, command);
}

function fileTransferCommandEntry(command) {
  return isFileTransferCommand(command) ? FILE_TRANSFER_COMMANDS[command] : null;
}

function listFileTransferCommands() {
  return Object.keys(FILE_TRANSFER_COMMANDS).map((command) => ({
    command,
    risk: FILE_TRANSFER_COMMANDS[command].risk,
    summary: FILE_TRANSFER_COMMANDS[command].summary,
  }));
}

// ---------------------------------------------------------------------------
// 入参归一与校验
// ---------------------------------------------------------------------------

const TRANSFER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[a-f0-9]{64}$/;
/** 源 fileTransferRoutes.ts:37 的字符清洗口径。 */
const UNSAFE_NAME_RE = /[\\/:*?"<>|]/g;

const isPlainObject = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const clipText = (value, max) => (typeof value === "string" ? value.slice(0, max) : "");

function isValidTransferId(id) {
  return typeof id === "string" && TRANSFER_ID_RE.test(id);
}

/**
 * 源 fileTransferRoutes.ts:37：危险字符替换为下划线、截到 120 字符、空即拒绝。
 * 额外要求清洗后必须是单层文件名 —— 源里 name 不参与路径拼接，但 scope 会被下游消费者
 * （开发者 App）当文件名使用，这里提前堵住 '..' / '/' 形态的路径段，避免把穿越引到别处。
 */
function sanitizeTransferName(raw) {
  const name = (raw == null ? "" : String(raw)).replace(UNSAFE_NAME_RE, "_").slice(0, 120);
  if (!name) throw transferFailure(400, "文件名不能为空");
  if (name === "." || name === ".." || name !== path.basename(name)) throw transferFailure(400, "文件名含不允许的路径段");
  return name;
}

/**
 * scope = { projectId, revision, kind source|preview, name, mime }（源 fileTransfers.ts:9）。
 * revision 只做整数校验（见文件头排除项），mime 缺省回落源 fileTransferRoutes.ts:41 的取值。
 */
function normalizeTransferScope(raw) {
  if (!isPlainObject(raw)) throw transferFailure(400, "传输 scope 必须是对象");
  const projectId = clipText(raw.projectId, 120).trim();
  if (!projectId) throw transferFailure(400, "projectId 必填");
  if (!Number.isSafeInteger(raw.revision) || raw.revision < 0) throw transferFailure(400, "revision 必须是非负安全整数");
  if (!TRANSFER_KINDS.includes(raw.kind)) throw transferFailure(400, "文件用途无效");
  const name = sanitizeTransferName(raw.name);
  const mime = clipText(raw.mime, 120).trim() || TRANSFER_DEFAULT_MIME[raw.kind];
  return { projectId, revision: raw.revision, kind: raw.kind, name, mime };
}

/** 源 fileTransfers.ts:31：1 字节..8GiB；源 fileTransferRoutes.ts:33：preview 不超 16MiB。 */
function assertTransferSize(size, kind) {
  if (!Number.isSafeInteger(size) || size <= 0 || size > TRANSFER_MAX_BYTES) throw transferFailure(400, "文件大小必须在 1 字节至 8GiB 之间");
  if (kind === "preview" && size > PREVIEW_MAX_BYTES) throw transferFailure(400, "项目预览不能超过 16MiB");
}

/** 源 fileTransfers.ts:51 的形状校验（offset / length / 单块上限 / 越界 / 封存后不可再写）。 */
function assertChunkShape({ offset, length, size, sealed }) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !length || length > TRANSFER_CHUNK_BYTES || offset + length > size || sealed) {
    throw transferFailure(400, "文件块无效");
  }
}

/** 源 fileTransfers.ts:74：只在提供了预期哈希时校验形态。 */
function assertSha256(expected) {
  if (expected && !SHA256_RE.test(expected)) throw transferFailure(400, "SHA-256 无效");
}

/** 源 fileTransfers.ts:35 的配额口径（调用方把 size 已计入 ownerBytes / reservedBytes）。 */
function assertTransferAdmission({ ownerCount, ownerBytes, reservedBytes, sessionCount }) {
  if (ownerCount >= TRANSFER_MAX_OWNED || ownerBytes > TRANSFER_MAX_OWNER_BYTES || reservedBytes > TRANSFER_MAX_RESERVED_BYTES || sessionCount >= TRANSFER_MAX_SESSIONS) {
    throw transferFailure(429, "正在传输的文件过多");
  }
}

/** 源 fileTransfers.ts:28 view：只出不透明 id 与进度，绝不回宿主路径。 */
function transferView(item) {
  return {
    id: item.id,
    size: item.size,
    offset: item.offset,
    chunkBytes: TRANSFER_CHUNK_BYTES,
    expiresAt: item.expires,
    sha256: item.sha256,
  };
}

// ---------------------------------------------------------------------------
// 落盘路径围栏（源 fileTransfers.ts:37 用 randomUUID 命名，天然无用户输入进路径）
// ---------------------------------------------------------------------------

/** 路径包含判定：candidate 必须等于 root 或落在 root 之内。 */
function isContainedPath(root, candidate) {
  const base = path.resolve(String(root));
  const target = path.resolve(String(candidate));
  return target === base || target.startsWith(base + path.sep);
}

function stagingFileName(id) {
  return id + TRANSFER_STAGING_SUFFIX;
}

/**
 * 解析某个传输的暂存文件绝对路径。
 * 为什么先卡 UUID：源用 randomUUID() 生成 id，路径里只有 id；这里把"id 必须是 UUID"
 * 显式化，任何 '..' / 绝对路径 / 带分隔符的 id 在拼路径之前就被拒。
 */
function resolveStagingPath(root, id) {
  if (!isValidTransferId(id)) throw createFileTransferError(FILE_TRANSFER_ERR_PATH_ESCAPE, "传输 ID 不是合法 UUID，拒绝拼接路径");
  const candidate = path.join(path.resolve(String(root)), stagingFileName(id));
  if (!isContainedPath(root, candidate)) throw createFileTransferError(FILE_TRANSFER_ERR_PATH_ESCAPE, "传输落盘路径越界");
  return candidate;
}

module.exports = {
  TRANSFER_CHUNK_BYTES,
  TRANSFER_MAX_BYTES,
  TRANSFER_TTL_MS,
  PREVIEW_MAX_BYTES,
  TRANSFER_KINDS,
  TRANSFER_MAX_OWNED,
  TRANSFER_MAX_OWNER_BYTES,
  TRANSFER_MAX_RESERVED_BYTES,
  TRANSFER_MAX_SESSIONS,
  TRANSFER_STAGING_SUFFIX,
  TRANSFER_DEFAULT_MIME,

  FILE_TRANSFER_ERR_COMMAND_NOT_ALLOWED,
  FILE_TRANSFER_ERR_INVALID_INPUT,
  FILE_TRANSFER_ERR_UNAUTHENTICATED,
  FILE_TRANSFER_ERR_NOT_FOUND,
  FILE_TRANSFER_ERR_CONFLICT,
  FILE_TRANSFER_ERR_QUOTA_EXCEEDED,
  FILE_TRANSFER_ERR_PATH_ESCAPE,
  FILE_TRANSFER_ERR_NOT_READY,
  FILE_TRANSFER_ERR_INTERNAL,
  FILE_TRANSFER_ERROR_CODES,
  TRANSFER_STATUS_CODE,

  createFileTransferError,
  transferFailure,
  isFileTransferError,
  redactFileTransferValue,
  normalizeFileTransferError,
  toFileTransferIpcResult,
  fileTransferCommandNotAllowed,

  FILE_TRANSFER_COMMANDS,
  isFileTransferCommand,
  fileTransferCommandEntry,
  listFileTransferCommands,

  isValidTransferId,
  sanitizeTransferName,
  normalizeTransferScope,
  assertTransferSize,
  assertChunkShape,
  assertSha256,
  assertTransferAdmission,
  transferView,

  isContainedPath,
  stagingFileName,
  resolveStagingPath,
};
