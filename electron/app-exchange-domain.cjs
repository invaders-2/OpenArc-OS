/**
 * 应用互传域 · 纯逻辑层（**无 I/O，无 Electron**）。
 *
 * 逐段移植自只读源（行号为源文件行号）：
 *   · shared/appExchange.ts:2-19   ExchangeAsset / ExchangeRequest / ExchangeResult 三个消息形状
 *   · shared/appExchange.ts:21-25  APP_EXCHANGE_TARGETS 三个 target（edit / receive / canvas import）
 *   · server/appExchange.ts:11     MAX_IMAGE_BYTES = 64 MiB
 *   · server/appExchange.ts:18-21  identifier 正则（[a-zA-Z0-9_-]{1,128}）
 *   · server/appExchange.ts:22-38  validateExchangeRequest（target 查表、画布必选、PhotoCraft 不覆盖）
 *   · server/appExchange.ts:39-51  inspectExchangeAsset（可读判定、mime、大小、revision）
 *   · server/appExchange.ts:46     accepts = png / jpeg / webp
 *   · server/appExchange.ts:61     fingerprint = sha256(JSON.stringify(normalizedInput))
 *   · server/appExchange.ts:80-85  sharp metadata 的 format / 像素 / pages 与声明 mime 比对
 *   · server/appExchangeRoutes.ts:14-28 四条 JSON 路由的返回投影（version:1 / targets / canvases / asset）
 *   · server/appExchangeRoutes.ts:29-47 /api/app-exchange-images：唯一**允许字节**的入口（multipart）
 *
 * 为什么单独一层：appExchange:command 是新增顶层 IPC 通道，target 表映射、消息形状、只传引用的边界、
 * 失败回什么码必须先在一处冻结。命令表本身即白名单，未登记命令一律 COMMAND_NOT_ALLOWED，不做动态 dispatch。
 *
 * ## target 表映射（Lead 已确认的方案 B 第 4 条）
 *   DX 源里 image.edit / image.receive 两个 target 的 appId 都是 dev-photocraft；本仓没有该应用，
 *   故把它们的 appId 映射为自有图像工坊 appId = "image-studio"，并在导出的 target 表里保留
 *   sourceAppId = "dev-photocraft" / sourceTitle 作为**只读备注**，绝不把 dev-photocraft 伪装成可用 target。
 *   第三个 target canvas（image.import）语义不变，sourceAppId 与 appId 相同。凭据/dev-photocraft 的
 *   存在性由调用方 canOpen 判定，本层不臆造。
 *
 * 刻意排除：云能力（cloudAccount / 云 AI / api.dx-os.com / 计费 apiQuota）一个字段都不接收；
 * server/appExchangeRoutes.ts:1 的 express/multer 依赖不进本层（IPC 由 bootstrap 落）。
 */
"use strict";

const { createHash } = require("node:crypto");
const foundationErrors = require("./dxos-foundation-errors.cjs");

// ---------------------------------------------------------------------------
// 常量（源 server/appExchange.ts:11、:46、:80-85、:118、:124；shared/appExchange.ts:21-25）
// ---------------------------------------------------------------------------

/** 源 appExchange.ts:11 MAX_IMAGE_BYTES。 */
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
/** 源 appExchange.ts:80-82 limitInputPixels / 像素上限（64M 像素）。 */
const MAX_IMAGE_PIXELS = 64 * 1024 * 1024;
/** 源 appExchange.ts:46：三个 target 的 accepts 集合。 */
const EXCHANGE_ACCEPTED_MIMES = Object.freeze(["image/png", "image/jpeg", "image/webp"]);
/** 源 appExchange.ts:84：sharp format → mime 的映射。 */
const IMAGE_FORMAT_MIME = Object.freeze({ png: "image/png", jpeg: "image/jpeg", webp: "image/webp" });
/** 源 appExchangeRoutes.ts:16：协议版本字面量。 */
const APP_EXCHANGE_VERSION = 1;
/** 源 appExchange.ts:118-121：画布卡片默认尺寸与高度夹取。 */
const CANVAS_CARD_WIDTH = 300;
const CANVAS_CARD_MIN_HEIGHT = 100;
const CANVAS_CARD_MAX_HEIGHT = 600;
/** 源 appExchange.ts:124：画布落点期望坐标。 */
const CANVAS_CARD_DESIRED = Object.freeze({ x: 480, y: 300 });
/** 源 appExchangeRoutes.ts:42：图像工坊上传落到的文件夹名。 */
const APP_EXCHANGE_FOLDER_NAME = "应用互联";
/** 源 appExchangeRoutes.ts:43：上传文件名兜底与清洗口径。 */
const APP_EXCHANGE_DEFAULT_IMAGE_NAME = "合成图.png";
const APP_EXCHANGE_NAME_MAX = 120;

/** 本仓自有图像工坊 appId（替代 DX 的 dev-photocraft）。 */
const IMAGE_STUDIO_APP_ID = "image-studio";
/** DX 原始 PhotoCraft appId（只作 sourceAppId 备注，绝不作为可用 target 暴露）。 */
const DX_PHOTOCRAFT_APP_ID = "dev-photocraft";
const CANVAS_APP_ID = "canvas";

/**
 * DX 原始 target 表（shared/appExchange.ts:21-25 逐字，只读审计对照）。
 * 保留它是为了让 APP_EXCHANGE_TARGETS 的每一条映射可被机械核对，而不是靠注释自证。
 */
const DX_APP_EXCHANGE_TARGETS = Object.freeze([
  Object.freeze({ appId: DX_PHOTOCRAFT_APP_ID, title: "PhotoCraft", action: "image.edit", accepts: EXCHANGE_ACCEPTED_MIMES, creates: "document" }),
  Object.freeze({ appId: DX_PHOTOCRAFT_APP_ID, title: "PhotoCraft 当前文档", action: "image.receive", accepts: EXCHANGE_ACCEPTED_MIMES, creates: "layer" }),
  Object.freeze({ appId: CANVAS_APP_ID, title: "无限画布", action: "image.import", accepts: EXCHANGE_ACCEPTED_MIMES, creates: "node" }),
]);

const PHOTOCRAFT_MAPPING_NOTE = "本仓无 dev-photocraft；等价物为 image-studio（DX 原始 target 见 sourceAppId/sourceTitle）";

/**
 * 导出的 target 表：字段名/accepts/creates 与源一致；appId 按方案 B 第 4 条映射；
 * sourceAppId/sourceTitle/mapping/mappingNote 是本仓只读备注，如实标注映射来源。
 */
const APP_EXCHANGE_TARGETS = Object.freeze([
  Object.freeze({
    appId: IMAGE_STUDIO_APP_ID,
    title: "图像工坊",
    action: "image.edit",
    accepts: EXCHANGE_ACCEPTED_MIMES,
    creates: "document",
    sourceAppId: DX_PHOTOCRAFT_APP_ID,
    sourceTitle: "PhotoCraft",
    mapping: "equivalent",
    mappingNote: PHOTOCRAFT_MAPPING_NOTE,
  }),
  Object.freeze({
    appId: IMAGE_STUDIO_APP_ID,
    title: "图像工坊 当前文档",
    action: "image.receive",
    accepts: EXCHANGE_ACCEPTED_MIMES,
    creates: "layer",
    sourceAppId: DX_PHOTOCRAFT_APP_ID,
    sourceTitle: "PhotoCraft 当前文档",
    mapping: "equivalent",
    mappingNote: PHOTOCRAFT_MAPPING_NOTE,
  }),
  Object.freeze({
    appId: CANVAS_APP_ID,
    title: "无限画布",
    action: "image.import",
    accepts: EXCHANGE_ACCEPTED_MIMES,
    creates: "node",
    sourceAppId: CANVAS_APP_ID,
    sourceTitle: "无限画布",
    mapping: "identity",
    mappingNote: "",
  }),
]);

// ---------------------------------------------------------------------------
// 错误规约（与 FILE_TRANSFER_* / MEDIA_* 同形：域自有码，不并进 DXOS_*）
// ---------------------------------------------------------------------------

const APP_EXCHANGE_ERR_COMMAND_NOT_ALLOWED = "APP_EXCHANGE_COMMAND_NOT_ALLOWED";
const APP_EXCHANGE_ERR_INVALID_INPUT = "APP_EXCHANGE_INVALID_INPUT";
const APP_EXCHANGE_ERR_UNAUTHENTICATED = "APP_EXCHANGE_UNAUTHENTICATED";
const APP_EXCHANGE_ERR_NOT_FOUND = "APP_EXCHANGE_NOT_FOUND";
const APP_EXCHANGE_ERR_CONFLICT = "APP_EXCHANGE_CONFLICT";
const APP_EXCHANGE_ERR_FORBIDDEN = "APP_EXCHANGE_FORBIDDEN";
const APP_EXCHANGE_ERR_TARGET_UNSUPPORTED = "APP_EXCHANGE_TARGET_UNSUPPORTED";
/** 只传引用不传字节：命中即拒绝（shared/appExchange.ts:1 的 "never image bytes/URLs"）。 */
const APP_EXCHANGE_ERR_BYTES_NOT_ALLOWED = "APP_EXCHANGE_BYTES_NOT_ALLOWED";
const APP_EXCHANGE_ERR_STALE_REVISION = "APP_EXCHANGE_STALE_REVISION";
const APP_EXCHANGE_ERR_TOO_LARGE = "APP_EXCHANGE_TOO_LARGE";
const APP_EXCHANGE_ERR_IMAGE_INVALID = "APP_EXCHANGE_IMAGE_INVALID";
const APP_EXCHANGE_ERR_IMAGE_ENGINE_UNAVAILABLE = "APP_EXCHANGE_IMAGE_ENGINE_UNAVAILABLE";
const APP_EXCHANGE_ERR_DEPENDENCY_UNAVAILABLE = "APP_EXCHANGE_DEPENDENCY_UNAVAILABLE";
const APP_EXCHANGE_ERR_NOT_READY = "APP_EXCHANGE_NOT_READY";
const APP_EXCHANGE_ERR_INTERNAL = "APP_EXCHANGE_INTERNAL";

const APP_EXCHANGE_ERROR_CODES = Object.freeze([
  APP_EXCHANGE_ERR_COMMAND_NOT_ALLOWED,
  APP_EXCHANGE_ERR_INVALID_INPUT,
  APP_EXCHANGE_ERR_UNAUTHENTICATED,
  APP_EXCHANGE_ERR_NOT_FOUND,
  APP_EXCHANGE_ERR_CONFLICT,
  APP_EXCHANGE_ERR_FORBIDDEN,
  APP_EXCHANGE_ERR_TARGET_UNSUPPORTED,
  APP_EXCHANGE_ERR_BYTES_NOT_ALLOWED,
  APP_EXCHANGE_ERR_STALE_REVISION,
  APP_EXCHANGE_ERR_TOO_LARGE,
  APP_EXCHANGE_ERR_IMAGE_INVALID,
  APP_EXCHANGE_ERR_IMAGE_ENGINE_UNAVAILABLE,
  APP_EXCHANGE_ERR_DEPENDENCY_UNAVAILABLE,
  APP_EXCHANGE_ERR_NOT_READY,
  APP_EXCHANGE_ERR_INTERNAL,
]);

function createAppExchangeError(code, message, detail) {
  const err = new Error(foundationErrors.redactText(message == null ? code : message));
  err.name = "AppExchangeError";
  err.code = APP_EXCHANGE_ERROR_CODES.includes(code) ? code : APP_EXCHANGE_ERR_INTERNAL;
  if (detail !== undefined) err.detail = foundationErrors.redactValue(detail);
  return err;
}

const invalidInput = (message, detail) => createAppExchangeError(APP_EXCHANGE_ERR_INVALID_INPUT, message, detail);
const forbidden = (message, detail) => createAppExchangeError(APP_EXCHANGE_ERR_FORBIDDEN, message, detail);
const notFound = (message, detail) => createAppExchangeError(APP_EXCHANGE_ERR_NOT_FOUND, message, detail);
const conflict = (message, detail) => createAppExchangeError(APP_EXCHANGE_ERR_CONFLICT, message, detail);

function isAppExchangeError(err) {
  return !!err && typeof err === "object" && typeof err.code === "string" && APP_EXCHANGE_ERROR_CODES.includes(err.code);
}

function normalizeAppExchangeError(err) {
  if (isAppExchangeError(err)) {
    const out = { ok: false, error: err.code, message: foundationErrors.redactText(err.message || err.code) || err.code };
    if (err.detail !== undefined) out.detail = foundationErrors.redactValue(err.detail);
    return out;
  }
  return foundationErrors.normalizeError(err, { fallbackCode: foundationErrors.DXOS_ERR_INTERNAL });
}

async function toAppExchangeIpcResult(action) {
  try {
    const value = typeof action === "function" ? await action() : await action;
    return { ok: true, value: foundationErrors.redactValue(value) };
  } catch (err) {
    return normalizeAppExchangeError(err);
  }
}

function appExchangeCommandNotAllowed(command) {
  return createAppExchangeError(
    APP_EXCHANGE_ERR_COMMAND_NOT_ALLOWED,
    "未知或未授权的 appExchange 命令：" + String(command == null ? "" : command),
    { command: command == null ? null : String(command) },
  );
}

function dependencyUnavailable(name) {
  return createAppExchangeError(APP_EXCHANGE_ERR_DEPENDENCY_UNAVAILABLE, "应用互传依赖不可用：" + String(name || "unknown"), { dependency: String(name || "unknown") });
}

// ---------------------------------------------------------------------------
// 命令白名单（顶层 IPC 面 appExchange:command；risk/summary 供 UI 与审计）
// ---------------------------------------------------------------------------

const APP_EXCHANGE_COMMANDS = Object.freeze({
  "appExchange/targets": { risk: "read", summary: "列出当前用户可打开的应用互传 target 与可写画布" },
  "appExchange/get": { risk: "read", summary: "按 id 读取一条已完成的互传记录（仅本人）" },
  "appExchange/exchange": { risk: "manage", summary: "按 requestId 把素材引用发送到目标应用（幂等，不传字节）" },
  "appExchange/inspect": { risk: "read", summary: "只读检查素材的可读性、mime、大小与 revision" },
  "appExchange-images": { risk: "manage", summary: "上传图片字节生成素材节点（应用互传唯一的字节通道）" },
});

function isAppExchangeCommand(command) {
  return typeof command === "string" && Object.prototype.hasOwnProperty.call(APP_EXCHANGE_COMMANDS, command);
}

function appExchangeCommandEntry(command) {
  return isAppExchangeCommand(command) ? APP_EXCHANGE_COMMANDS[command] : null;
}

function listAppExchangeCommands() {
  return Object.keys(APP_EXCHANGE_COMMANDS).map((command) => ({
    command,
    risk: APP_EXCHANGE_COMMANDS[command].risk,
    summary: APP_EXCHANGE_COMMANDS[command].summary,
  }));
}

// ---------------------------------------------------------------------------
// 形状校验（字段名/可空性/字面量一字不改）
// ---------------------------------------------------------------------------

const IDENTIFIER_RE = /^[a-zA-Z0-9_-]{1,128}$/; // 源 appExchange.ts:19
const EXCHANGE_REQUEST_KEYS = Object.freeze(["requestId", "target", "asset"]);
const EXCHANGE_TARGET_KEYS = Object.freeze(["appId", "action", "projectId"]);
const EXCHANGE_ASSET_KEYS = Object.freeze(["nodeId", "canvasId", "photoCraftProjectId", "revision"]);
/**
 * 只传引用：这些键名与二进制值一律拒绝。shared/appExchange.ts:1 明确 "never image bytes/URLs"，
 * 所以 URL 形态同样拒绝 —— 引用只能是不透明的 nodeId / canvasId / photoCraftProjectId。
 */
const REFERENCE_FORBIDDEN_KEYS = Object.freeze(["bytes", "data", "base64", "blob", "buffer", "content", "file", "image", "url", "dataUrl", "src", "path"]);
const REVISION_MAX = 128; // 源 appExchange.ts:35 String(...).slice(0,128)

const isPlainObject = (value) => !!value && typeof value === "object" && !Array.isArray(value);

function identifier(value, name) {
  if (typeof value !== "string" || !IDENTIFIER_RE.test(value)) throw invalidInput(name + "无效", { field: name });
  return value;
}

function assertAllowedKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw invalidInput(label + "含未知字段：" + key, { field: key });
  }
}

/** 递归拒绝二进制值与字节/URL 字段名；只在 JSON 引用协议的两条命令上调用。 */
function assertReferenceOnly(value, path = "", depth = 0) {
  if (value == null) return;
  const type = typeof value;
  if (type === "string" || type === "number" || type === "boolean" || type === "bigint") return;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array || value instanceof ArrayBuffer) {
    throw createAppExchangeError(APP_EXCHANGE_ERR_BYTES_NOT_ALLOWED, "应用互传只传引用，不接收图片字节", { field: path || "payload" });
  }
  if (type !== "object") return;
  if (depth > 5) throw invalidInput("应用互传请求嵌套过深", { field: path || "payload" });
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertReferenceOnly(item, path + "[" + index + "]", depth + 1));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    const next = path ? path + "." + key : key;
    if (REFERENCE_FORBIDDEN_KEYS.includes(key)) {
      throw createAppExchangeError(APP_EXCHANGE_ERR_BYTES_NOT_ALLOWED, "应用互传只传引用，不接收图片字节或 URL", { field: next });
    }
    assertReferenceOnly(item, next, depth + 1);
  }
}

/** 源 appExchange.ts:31-36 的 asset 归一（可空字段缺省即不出现）。 */
function normalizeExchangeAsset(raw) {
  if (!isPlainObject(raw)) throw invalidInput("asset 必须是对象", { field: "asset" });
  assertAllowedKeys(raw, EXCHANGE_ASSET_KEYS, "asset");
  const asset = { nodeId: identifier(raw.nodeId, "素材 ID") };
  if (raw.canvasId) asset.canvasId = identifier(raw.canvasId, "来源画布");
  if (raw.photoCraftProjectId) asset.photoCraftProjectId = identifier(raw.photoCraftProjectId, "来源项目");
  if (raw.revision) asset.revision = String(raw.revision).slice(0, REVISION_MAX);
  return asset;
}

function findExchangeTarget(appId, action) {
  return APP_EXCHANGE_TARGETS.find((item) => item.appId === appId && item.action === action) || null;
}

/** 源 appExchange.ts:22-38：target 查表 → projectId 归一 → 画布必选 / 图像工坊不覆盖已有项目。 */
function validateExchangeRequest(raw) {
  assertReferenceOnly(raw);
  if (!isPlainObject(raw)) throw invalidInput("exchange 请求必须是对象");
  assertAllowedKeys(raw, EXCHANGE_REQUEST_KEYS, "exchange 请求");
  if (!isPlainObject(raw.target)) throw invalidInput("target 必须是对象", { field: "target" });
  assertAllowedKeys(raw.target, EXCHANGE_TARGET_KEYS, "target");
  const target = findExchangeTarget(raw.target.appId, raw.target.action);
  if (!target) throw createAppExchangeError(APP_EXCHANGE_ERR_TARGET_UNSUPPORTED, "目标应用不支持此操作", { appId: raw.target.appId == null ? null : String(raw.target.appId), action: raw.target.action == null ? null : String(raw.target.action) });
  const projectId = raw.target.projectId ? identifier(raw.target.projectId, "目标项目") : undefined;
  if (target.appId === CANVAS_APP_ID && !projectId) throw invalidInput("请选择目标画布", { field: "target.projectId" });
  if (target.appId === IMAGE_STUDIO_APP_ID && projectId) throw invalidInput("目前仅支持新建图像工坊项目，不覆盖已有项目", { field: "target.projectId" });
  return {
    requestId: identifier(raw.requestId, "请求 ID"),
    target: { appId: target.appId, action: target.action, ...(projectId ? { projectId } : {}) },
    asset: normalizeExchangeAsset(raw.asset),
  };
}

/** 源 appExchange.ts:61：同一归一化请求即同一 fingerprint，用于 requestId 幂等判定。 */
function fingerprintOf(input) {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

/**
 * 源 appExchange.ts:80-85 的强制图片校验（不信任声明的 node.mime）。
 * 纯函数，sharp 的调用留在 service 层（sharp 只能惰性 require）。
 */
function evaluateImageMetadata(metadata, declaredMime) {
  const format = metadata && metadata.format;
  if (!metadata || !metadata.width || !metadata.height || !IMAGE_FORMAT_MIME[format]) {
    throw createAppExchangeError(APP_EXCHANGE_ERR_IMAGE_INVALID, "图片格式无效");
  }
  if (metadata.width * metadata.height > MAX_IMAGE_PIXELS) throw createAppExchangeError(APP_EXCHANGE_ERR_IMAGE_INVALID, "图片超过 64M 像素");
  if ((metadata.pages || 1) > 1) throw createAppExchangeError(APP_EXCHANGE_ERR_IMAGE_INVALID, "请先将动态图导出为静态图片");
  const actualMime = IMAGE_FORMAT_MIME[format];
  if (actualMime !== declaredMime) throw createAppExchangeError(APP_EXCHANGE_ERR_IMAGE_INVALID, "图片格式与声明的文件类型不一致");
  return actualMime;
}

/** 源 appExchangeRoutes.ts:43：文件名清洗与截断（不进路径，仅作节点名）。 */
function sanitizeImageName(raw) {
  const name = (raw == null ? "" : String(raw)).replace(/[\\/:*?"<>|]/g, "_").slice(0, APP_EXCHANGE_NAME_MAX);
  return name || APP_EXCHANGE_DEFAULT_IMAGE_NAME;
}

module.exports = {
  MAX_IMAGE_BYTES,
  MAX_IMAGE_PIXELS,
  EXCHANGE_ACCEPTED_MIMES,
  IMAGE_FORMAT_MIME,
  APP_EXCHANGE_VERSION,
  CANVAS_CARD_WIDTH,
  CANVAS_CARD_MIN_HEIGHT,
  CANVAS_CARD_MAX_HEIGHT,
  CANVAS_CARD_DESIRED,
  APP_EXCHANGE_FOLDER_NAME,
  APP_EXCHANGE_DEFAULT_IMAGE_NAME,
  APP_EXCHANGE_NAME_MAX,
  IMAGE_STUDIO_APP_ID,
  DX_PHOTOCRAFT_APP_ID,
  CANVAS_APP_ID,
  DX_APP_EXCHANGE_TARGETS,
  APP_EXCHANGE_TARGETS,
  PHOTOCRAFT_MAPPING_NOTE,

  APP_EXCHANGE_ERR_COMMAND_NOT_ALLOWED,
  APP_EXCHANGE_ERR_INVALID_INPUT,
  APP_EXCHANGE_ERR_UNAUTHENTICATED,
  APP_EXCHANGE_ERR_NOT_FOUND,
  APP_EXCHANGE_ERR_CONFLICT,
  APP_EXCHANGE_ERR_FORBIDDEN,
  APP_EXCHANGE_ERR_TARGET_UNSUPPORTED,
  APP_EXCHANGE_ERR_BYTES_NOT_ALLOWED,
  APP_EXCHANGE_ERR_STALE_REVISION,
  APP_EXCHANGE_ERR_TOO_LARGE,
  APP_EXCHANGE_ERR_IMAGE_INVALID,
  APP_EXCHANGE_ERR_IMAGE_ENGINE_UNAVAILABLE,
  APP_EXCHANGE_ERR_DEPENDENCY_UNAVAILABLE,
  APP_EXCHANGE_ERR_NOT_READY,
  APP_EXCHANGE_ERR_INTERNAL,
  APP_EXCHANGE_ERROR_CODES,

  createAppExchangeError,
  invalidInput,
  forbidden,
  notFound,
  conflict,
  isAppExchangeError,
  normalizeAppExchangeError,
  toAppExchangeIpcResult,
  appExchangeCommandNotAllowed,
  dependencyUnavailable,

  APP_EXCHANGE_COMMANDS,
  isAppExchangeCommand,
  appExchangeCommandEntry,
  listAppExchangeCommands,

  isPlainObject,
  identifier,
  assertAllowedKeys,
  assertReferenceOnly,
  normalizeExchangeAsset,
  findExchangeTarget,
  validateExchangeRequest,
  fingerprintOf,
  evaluateImageMetadata,
  sanitizeImageName,
};
