/**
 * PhotoCraft（图像工坊）域 · 纯逻辑层（无 I/O、无 Electron）。
 *
 * 逐段移植自只读源（行号为源文件行号）：
 *   · server/photocraftProjects.ts:6            PhotoCraftVisibility 三态
 *   · server/photocraftProjects.ts:23-25        虚拟树目录名（PhotoCraft / 项目缓存 / 默认分组）
 *   · server/photocraftProjects.ts:28-33        cleanTitle / visibility 归一
 *   · server/photocraftProjects.ts:38-40        canView（owner / public / restricted+成员三路）
 *   · server/photocraftProjects.ts:61-75        summary 投影
 *   · server/photocraftProjects.ts:314-319      canViewPhotoCraftFile
 *   · server/index.ts:5748-5843                 /api/photocraft/* 路由落成 photocraft:command
 *   · server/index.ts:9906                      MAX_DEVELOPER_PROJECT_BINARY_BYTES = 24MiB（base64 通道上限）
 *   · server/index.ts:5749                      multer fileSize = 100MiB（源文件上传上限）
 *   · server/photocraftRuntime.ts:1-34          WASM 等长文案替换（纯 Buffer 工具）
 *   · server/photocraftRuntime.ts:36-63         工作区运行时脚本（仅字符串，不做任何注入）
 *
 * 为什么单独一层：photocraft:command 是新增顶层 IPC 通道，"可调用哪些命令、入参怎么归一、
 * 三态可见性怎么判、失败回什么码"必须先在一处冻结，再交给 photocraft-service.cjs 落盘、
 * photocraft-bootstrap.cjs 注册。命令表本身即白名单，未登记命令一律
 * PHOTOCRAFT_COMMAND_NOT_ALLOWED，不做动态 dispatch。
 *
 * 方案 B 边界（用户已确认）：只做项目容器与文件能力，**不引入任何第三方 WASM 编辑器**，
 * 不做 wasm 加载 / 注入。photocraftRuntime 只移植纯文本替换工具与运行时脚本字符串；
 * 源里的 invoke('photocraft.workspace', ...) 通道**不注册**——它不属于冻结的
 * photocraft:command 契约，注册它等于凭空造通道。
 *
 * 云与计费 OUT：本文件零引用 cloudAccount / apiQuota / api.dx-os.com / 云 AI。
 */
"use strict";

const foundationErrors = require("./dxos-foundation-errors.cjs");

// ── 通道与虚拟树目录（源 photocraftProjects.ts:23-25）──────────────────────
const PHOTOCRAFT_CHANNEL = "photocraft:command";
const PHOTOCRAFT_APP_FOLDER = "PhotoCraft";
const PHOTOCRAFT_CACHE_FOLDER = "项目缓存";
const PHOTOCRAFT_GROUPS_FOLDER = "分组";
const PHOTOCRAFT_DEFAULT_GROUP = "默认分组";
const PHOTOCRAFT_EXPORT_FOLDER = "导出";
const PHOTOCRAFT_TEMP_FOLDER = "临时";

// ── 三态与默认值（源 photocraftProjects.ts:6、:31-32）──────────────────────
const PHOTOCRAFT_VISIBILITIES = Object.freeze(["private", "public", "restricted"]);
const PHOTOCRAFT_DEFAULT_VISIBILITY = "private";
const PHOTOCRAFT_DEFAULT_TITLE = "未命名项目";
const PHOTOCRAFT_DEFAULT_GROUP_NAME = "新分组";
const PHOTOCRAFT_DEFAULT_SOURCE_NAME = "source.bin";
const PHOTOCRAFT_DEFAULT_EXPORT_NAME = "export.bin";
const PHOTOCRAFT_DEFAULT_CLIPBOARD_NAME = "剪贴板粘贴.png";
const PHOTOCRAFT_DEFAULT_MIME = "application/octet-stream";
const PHOTOCRAFT_DEFAULT_CLIPBOARD_MIME = "image/png";

// ── 长度上限（括号内为源行号）──────────────────────────────────────────────
const PHOTOCRAFT_MAX_TITLE = 120;          // cleanTitle .slice(0,120)（:29）
const PHOTOCRAFT_MAX_MIME = 160;           // saveSource .slice(0,160)（:115、:189）
const PHOTOCRAFT_MAX_MEMBERS = 100;        // updatePhotoCraftProject .slice(0,100)（:163）
const PHOTOCRAFT_MAX_ID = 128;             // appExchange.ts:19 identifier /^[a-zA-Z0-9_-]{1,128}$/
const PHOTOCRAFT_MAX_INLINE_BYTES = 24 * 1024 * 1024;  // index.ts:9906
const PHOTOCRAFT_MAX_SOURCE_BYTES = 100 * 1024 * 1024; // index.ts:5749 multer fileSize

const PHOTOCRAFT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const PHOTOCRAFT_BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

// ── 错误规约（与 FILE_TRANSFER_* / CANVAS_* 同形：域自有码）────────────────
const PHOTOCRAFT_ERR_COMMAND_NOT_ALLOWED = "PHOTOCRAFT_COMMAND_NOT_ALLOWED";
const PHOTOCRAFT_ERR_INVALID_INPUT = "PHOTOCRAFT_INVALID_INPUT";
const PHOTOCRAFT_ERR_UNAUTHENTICATED = "PHOTOCRAFT_UNAUTHENTICATED";
const PHOTOCRAFT_ERR_NOT_FOUND = "PHOTOCRAFT_NOT_FOUND";
const PHOTOCRAFT_ERR_FORBIDDEN = "PHOTOCRAFT_FORBIDDEN";
const PHOTOCRAFT_ERR_CONFLICT = "PHOTOCRAFT_CONFLICT";
const PHOTOCRAFT_ERR_TOO_LARGE = "PHOTOCRAFT_TOO_LARGE";
const PHOTOCRAFT_ERR_UNSUPPORTED = "PHOTOCRAFT_UNSUPPORTED";
const PHOTOCRAFT_ERR_NOT_READY = "PHOTOCRAFT_NOT_READY";
const PHOTOCRAFT_ERR_INTERNAL = "PHOTOCRAFT_INTERNAL";

const PHOTOCRAFT_ERROR_CODES = Object.freeze([
  PHOTOCRAFT_ERR_COMMAND_NOT_ALLOWED,
  PHOTOCRAFT_ERR_INVALID_INPUT,
  PHOTOCRAFT_ERR_UNAUTHENTICATED,
  PHOTOCRAFT_ERR_NOT_FOUND,
  PHOTOCRAFT_ERR_FORBIDDEN,
  PHOTOCRAFT_ERR_CONFLICT,
  PHOTOCRAFT_ERR_TOO_LARGE,
  PHOTOCRAFT_ERR_UNSUPPORTED,
  PHOTOCRAFT_ERR_NOT_READY,
  PHOTOCRAFT_ERR_INTERNAL,
]);

function createPhotocraftError(code, message, detail) {
  const err = new Error(foundationErrors.redactText(message == null ? code : message));
  err.name = "PhotocraftError";
  err.code = PHOTOCRAFT_ERROR_CODES.includes(code) ? code : PHOTOCRAFT_ERR_INTERNAL;
  if (detail !== undefined) err.detail = foundationErrors.redactValue(detail);
  return err;
}

function isPhotocraftError(err) {
  return !!err && typeof err === "object" && typeof err.code === "string" && PHOTOCRAFT_ERROR_CODES.includes(err.code);
}

function redactPhotocraftValue(value) {
  return foundationErrors.redactValue(value);
}

function normalizePhotocraftError(err) {
  if (isPhotocraftError(err)) {
    const out = { ok: false, error: err.code, message: foundationErrors.redactText(err.message || err.code) || err.code };
    if (err.detail !== undefined) out.detail = foundationErrors.redactValue(err.detail);
    return out;
  }
  return foundationErrors.normalizeError(err, { fallbackCode: foundationErrors.DXOS_ERR_INTERNAL });
}

async function toPhotocraftIpcResult(action) {
  try {
    const value = typeof action === "function" ? await action() : await action;
    return { ok: true, value: redactPhotocraftValue(value) };
  } catch (err) {
    return normalizePhotocraftError(err);
  }
}

function photocraftCommandNotAllowed(command) {
  return createPhotocraftError(
    PHOTOCRAFT_ERR_COMMAND_NOT_ALLOWED,
    "未知或未授权的 photocraft 命令：" + String(command == null ? "" : command),
    { command: command == null ? null : String(command) },
  );
}

// ── 命令表（顶层 IPC 面；risk/summary 供 UI 与审计）────────────────────────
const PHOTOCRAFT_COMMANDS = Object.freeze({
  "photocraft/projects/list": { risk: "read", summary: "列出当前用户可见的项目与分组（private/public/restricted 三态过滤）" },
  "photocraft/projects/create": { risk: "write", summary: "新建项目（缺省落在默认分组；可同时写入源文件）" },
  "photocraft/projects/get": { risk: "read", summary: "读取单个项目详情（含 sourceUrl 与预览 URL）" },
  "photocraft/projects/update": { risk: "write", summary: "仅 owner 可改：改名 / 换分组 / 改 visibility / 整表替换成员" },
  "photocraft/projects/trash": { risk: "delete", summary: "把项目与其缓存目录移入 dxos-fs 回收站（软删，可恢复）" },
  "photocraft/projects/restore": { risk: "write", summary: "从回收站恢复项目与其缓存目录" },
  "photocraft/projects/purge": { risk: "delete", summary: "彻底删除项目与缓存目录（必须先进入回收站）" },
  "photocraft/projects/readSource": { risk: "read", summary: "内联读取源文件（base64；超过 24MiB 拒绝）" },
  "photocraft/projects/writeSource": { risk: "write", summary: "仅 owner 可写：覆盖既有源文件或新建源文件" },
  "photocraft/projects/export": { risk: "write", summary: "仅 owner：把导出产物写入项目 导出/ 目录并刷新预览" },
  "photocraft/projects/saveClipboardTemp": { risk: "write", summary: "仅 owner：把剪贴板图片写入项目 临时/ 目录（同名覆盖）" },
  "photocraft/projects/saveBundle": { risk: "write", summary: "结构化不支持：save-bundle 由 file-transfer 域承接" },
  "photocraft/trash/list": { risk: "read", summary: "列出当前用户回收站中的项目" },
  "photocraft/groups/create": { risk: "write", summary: "新建分组（同名复用，不重复建）" },
  "photocraft/groups/remove": { risk: "delete", summary: "删除分组并把其中项目移回默认分组" },
  // POST /api/photocraft/projects/:id/save-bundle 的连字符别名（同名同义，只为路由直译）。
  "photocraft/projects/save-bundle": { risk: "write", summary: "结构化不支持：save-bundle 由 file-transfer 域承接（连字符别名）" },
});

const PHOTOCRAFT_COMMAND_COUNT = Object.keys(PHOTOCRAFT_COMMANDS).length;

function isPhotocraftCommand(command) {
  return typeof command === "string" && Object.prototype.hasOwnProperty.call(PHOTOCRAFT_COMMANDS, command);
}

function photocraftCommandEntry(command) {
  return isPhotocraftCommand(command) ? PHOTOCRAFT_COMMANDS[command] : null;
}

function listPhotocraftCommands() {
  return Object.keys(PHOTOCRAFT_COMMANDS).map((command) => ({
    command: command,
    risk: PHOTOCRAFT_COMMANDS[command].risk,
    summary: PHOTOCRAFT_COMMANDS[command].summary,
  }));
}

// ── 入参归一与校验 ─────────────────────────────────────────────────────────
const isPlainObject = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const clipText = (value, max) => (typeof value === "string" ? value.slice(0, max) : value == null ? "" : String(value).slice(0, max));

function cleanTitle(value, fallback) {
  const title = String(value || "").trim().replace(/[\\/:*?"<>|]/g, "_").slice(0, PHOTOCRAFT_MAX_TITLE);
  return title || (fallback == null ? PHOTOCRAFT_DEFAULT_TITLE : String(fallback).slice(0, PHOTOCRAFT_MAX_TITLE));
}

function normalizeVisibility(value) {
  return value === "public" || value === "restricted" ? value : PHOTOCRAFT_DEFAULT_VISIBILITY;
}

/** 项目 / 分组 / 成员 id 形状：源用 randomUUID 生成项目与分组 id；成员 id 形如 usr_<base64url>。 */
function isValidPhotocraftId(value) {
  return typeof value === "string" && PHOTOCRAFT_ID_RE.test(value);
}

function requirePhotocraftId(value, label) {
  if (!isValidPhotocraftId(value)) throw createPhotocraftError(PHOTOCRAFT_ERR_INVALID_INPUT, (label || "ID") + "无效");
  return value;
}

/** 源 updatePhotoCraftProject:163 的成员归一：去重、排除 owner、截 100；这里额外做字符校验。 */
function normalizeMemberIds(value, ownerId) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const item of value) {
    if (item == null) continue;
    const id = String(item);
    if (!id || id === ownerId) continue;
    if (!isValidPhotocraftId(id)) throw createPhotocraftError(PHOTOCRAFT_ERR_INVALID_INPUT, "成员 ID 无效", { memberId: id });
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= PHOTOCRAFT_MAX_MEMBERS) break;
  }
  return out;
}

function assertPhotocraftSize(data, maxBytes, label) {
  if (data.byteLength > maxBytes) {
    throw createPhotocraftError(PHOTOCRAFT_ERR_TOO_LARGE, label + "超过 " + Math.ceil(maxBytes / 1024 / 1024) + " MB", { maxBytes: maxBytes, bytes: data.byteLength });
  }
  return data;
}

/**
 * 二进制入参解码：兼容 structured clone 的 Buffer / Uint8Array / ArrayBuffer，
 * 以及渲染层常用的 base64 字符串（源 index.ts:9918 developerBase64 的同款形态校验）。
 * 空值返回 null（源 createPhotoCraftProject:138 只在有 content 时才建源文件）。
 */
function decodeContentBytes(input, maxBytes, label) {
  const raw = input && input.contentBase64 !== undefined ? input.contentBase64 : input ? input.content : undefined;
  if (raw === undefined || raw === null || raw === "") return null;
  if (Buffer.isBuffer(raw)) return assertPhotocraftSize(raw, maxBytes, label);
  if (raw instanceof Uint8Array) return assertPhotocraftSize(Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength), maxBytes, label);
  if (raw instanceof ArrayBuffer) return assertPhotocraftSize(Buffer.from(raw), maxBytes, label);
  if (typeof raw === "string") {
    const clean = raw.split(/[ \t\r\n]+/).join("");
    if (!clean || !PHOTOCRAFT_BASE64_RE.test(clean) || clean.length % 4 !== 0) throw createPhotocraftError(PHOTOCRAFT_ERR_INVALID_INPUT, "二进制内容不是有效 Base64");
    return assertPhotocraftSize(Buffer.from(clean, "base64"), maxBytes, label);
  }
  throw createPhotocraftError(PHOTOCRAFT_ERR_INVALID_INPUT, label + "必须是 Buffer 或 base64 字符串");
}

// ── 可见性判定（源 photocraftProjects.ts:38-40、:314-319）──────────────────
function canViewProject(row, viewerId, memberIds) {
  if (!row || row.deleted_at !== null) return false;
  if (row.owner_id === viewerId) return true;
  if (row.visibility === "public") return true;
  return row.visibility === "restricted" && Array.isArray(memberIds) && memberIds.indexOf(viewerId) >= 0;
}

/** 源没有 canEditPhotoCraftFile —— 编辑严格等价于 owner（每处写操作都走 requireOwner）。 */
function canEditProject(row, viewerId) {
  return !!row && row.owner_id === viewerId;
}

/** 源 photocraftProjects.ts:61-75 的 summary 投影（纯函数，输入已取好的节点/成员）。 */
function buildProjectSummary(row, view) {
  const source = view.source || null;
  const preview = view.preview || null;
  const sourceMime = source ? String(source.mime || "") : "";
  const previewUrl = preview
    ? "/api/fs/thumbnail/" + preview.id + "?photocraft=" + row.id
    : sourceMime.indexOf("image/") === 0
      ? "/api/fs/thumbnail/" + source.id + "?photocraft=" + row.id
      : "";
  const summary = {
    id: row.id,
    groupId: row.group_id,
    ownerId: row.owner_id,
    ownerName: view.ownerName || "已删除用户",
    title: row.title,
    visibility: row.visibility,
    members: Array.isArray(view.members) ? view.members.slice(0, PHOTOCRAFT_MAX_MEMBERS) : [],
    mine: row.owner_id === view.viewerId,
    access: row.owner_id === view.viewerId ? "owner" : "read",
    sourceNodeId: source ? source.id : null,
    sourceName: source ? source.name : "",
    sourceMime: sourceMime,
    sourceSize: source ? Number(source.size) || 0 : 0,
    sourceSha256: source ? String(source.blobSha256 || "") : "",
    previewSha256: preview ? String(preview.blobSha256 || "") : "",
    previewUrl: previewUrl,
    statePath: row.state_path || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.deleted_at) summary.deletedAt = row.deleted_at;
  return summary;
}

// ── runtime：WASM 等长文案替换 + 工作区脚本（源 photocraftRuntime.ts）────────

const WELCOME_TEXT_PATCHES = [
  ['创建新文档或打开现有文件。', '管理项目并继续最近的编辑。'],
  ['开源', '项目'],
  ['新建文档…', '新建项目…'],
  ['打开…', '导入…'],
  ['将图像或 PSD 拖放到任意位置即可打开。', '将图像或 PSD 拖放到项目区域即可打开。'],
  ['加入我们的 Discord 社区', '进入我们的 Project 社区'],
  ['PhotoCraft 网站', 'ProjectHub 官网'],
]

function replaceEqualLengthUtf8(buffer, source, replacement) {
  const sourceBytes = Buffer.from(source, 'utf8')
  const replacementBytes = Buffer.from(replacement, 'utf8')
  if (sourceBytes.length !== replacementBytes.length) {
    throw new Error(`PhotoCraft 文案替换必须保持字节长度一致：${source}`)
  }
  let offset = 0
  let replacements = 0
  while ((offset = buffer.indexOf(sourceBytes, offset)) >= 0) {
    replacementBytes.copy(buffer, offset)
    offset += sourceBytes.length
    replacements += 1
  }
  return replacements
}

function patchPhotoCraftWasm(source) {
  const patched = Buffer.from(source)
  let replacements = 0
  for (const [from, to] of WELCOME_TEXT_PATCHES) {
    replacements += replaceEqualLengthUtf8(patched, from, to)
  }
  return replacements ? patched : source
}

function photoCraftWorkspaceRuntime() {
  return String.raw`
function installPhotoCraftWorkspace(){
  if(window.__dxPhotoCraftNativeWelcome)return;
  window.__dxPhotoCraftNativeWelcome=true;
  var syncing=false;
  function updatedLabel(value){try{return new Intl.DateTimeFormat('zh-CN',{year:'numeric',month:'numeric',day:'numeric'}).format(new Date(Number(value)||Date.now()))}catch(_){return''}}
  function syncProjects(){if(syncing)return;syncing=true;invoke('photocraft.workspace',{operation:'list'}).then(function(result){var raw=(result.projects||[]).filter(function(project){return project&&project.mine!==false});var projects=raw.map(function(project){return{id:String(project.id||''),groupId:String(project.groupId||''),title:String(project.title||'未命名项目'),sourceName:project.sourceName?String(project.sourceName):null,updatedLabel:updatedLabel(project.updatedAt),previewData:null}});var groups=(result.groups||[]).filter(function(group){return group&&group.mine!==false}).map(function(group){return{id:String(group.id||''),name:String(group.name||'未命名分组'),isDefault:!!group.isDefault}});localStorage.setItem('dxos.photocraft.projects',JSON.stringify(projects));localStorage.setItem('dxos.photocraft.groups',JSON.stringify(groups));dispatchEvent(new Event('resize'));raw.forEach(function(project){if(!project.previewUrl)return;var projectId=String(project.id||'');invoke('photocraft.workspace',{operation:'preview',projectId:projectId}).then(function(preview){if(!preview||!preview.data)return;var current=JSON.parse(localStorage.getItem('dxos.photocraft.projects')||'[]');var item=current.find(function(entry){return entry.id===projectId});if(!item)return;item.previewData=String(preview.data);localStorage.setItem('dxos.photocraft.projects',JSON.stringify(current));dispatchEvent(new Event('resize'))}).catch(function(){})});syncing=false}).catch(function(){syncing=false})}
  addEventListener('dxos:photocraft-open-project',function(){var id=localStorage.getItem('dxos.photocraft.open-project');if(id)invoke('photocraft.workspace',{operation:'open',projectId:id}).catch(function(error){alert(error.message||String(error))})});
  addEventListener('dxos:photocraft-action',function(){try{var action=JSON.parse(localStorage.getItem('dxos.photocraft.action')||'{}');invoke('photocraft.workspace',action).then(syncProjects).catch(function(error){alert(error.message||String(error))})}catch(error){alert(error.message||String(error))}});
  addEventListener('message',function(event){if(event.source!==parent)return;var message=event.data;if(!message||message.dxos!=='v1')return;if(message.type==='system.photocraft.projects-changed')syncProjects();if(message.type==='system.photocraft.split-progress')window.__dxPhotoCraftSplitProgress=String(message.message||'')});
  syncProjects();
  addEventListener('message',function(event){
    if(event.source!==parent)return;
    var message=event.data;
    if(!message||message.dxos!=='v1'||message.type!=='system.photocraft.receive-image')return;
    var queue=window.__dxPhotoCraftIncoming||(window.__dxPhotoCraftIncoming=[]);
    if(!(message.buffer instanceof ArrayBuffer)||message.buffer.byteLength>64*1024*1024||queue.length>=16){parent.postMessage({dxos:'v1',type:'system.photocraft.receive-result',id:message.id,ok:false,error:'接收队列繁忙或图片过大'},'*');return}
    queue.push(message);
    dispatchEvent(new Event('resize'));
  });
  parent.postMessage({dxos:'v1',type:'system.photocraft.workspace-ready'},'*');
}
addEventListener('DOMContentLoaded',function(){
  if(/photocraft/i.test(String(document.title||'')))installPhotoCraftWorkspace();
});
`
}

module.exports = {
  PHOTOCRAFT_CHANNEL,
  PHOTOCRAFT_APP_FOLDER,
  PHOTOCRAFT_CACHE_FOLDER,
  PHOTOCRAFT_GROUPS_FOLDER,
  PHOTOCRAFT_DEFAULT_GROUP,
  PHOTOCRAFT_EXPORT_FOLDER,
  PHOTOCRAFT_TEMP_FOLDER,

  PHOTOCRAFT_VISIBILITIES,
  PHOTOCRAFT_DEFAULT_VISIBILITY,
  PHOTOCRAFT_DEFAULT_TITLE,
  PHOTOCRAFT_DEFAULT_GROUP_NAME,
  PHOTOCRAFT_DEFAULT_SOURCE_NAME,
  PHOTOCRAFT_DEFAULT_EXPORT_NAME,
  PHOTOCRAFT_DEFAULT_CLIPBOARD_NAME,
  PHOTOCRAFT_DEFAULT_MIME,
  PHOTOCRAFT_DEFAULT_CLIPBOARD_MIME,

  PHOTOCRAFT_MAX_TITLE,
  PHOTOCRAFT_MAX_MIME,
  PHOTOCRAFT_MAX_MEMBERS,
  PHOTOCRAFT_MAX_ID,
  PHOTOCRAFT_MAX_INLINE_BYTES,
  PHOTOCRAFT_MAX_SOURCE_BYTES,
  PHOTOCRAFT_ID_RE,
  PHOTOCRAFT_BASE64_RE,

  PHOTOCRAFT_ERR_COMMAND_NOT_ALLOWED,
  PHOTOCRAFT_ERR_INVALID_INPUT,
  PHOTOCRAFT_ERR_UNAUTHENTICATED,
  PHOTOCRAFT_ERR_NOT_FOUND,
  PHOTOCRAFT_ERR_FORBIDDEN,
  PHOTOCRAFT_ERR_CONFLICT,
  PHOTOCRAFT_ERR_TOO_LARGE,
  PHOTOCRAFT_ERR_UNSUPPORTED,
  PHOTOCRAFT_ERR_NOT_READY,
  PHOTOCRAFT_ERR_INTERNAL,
  PHOTOCRAFT_ERROR_CODES,

  createPhotocraftError,
  isPhotocraftError,
  redactPhotocraftValue,
  normalizePhotocraftError,
  toPhotocraftIpcResult,
  photocraftCommandNotAllowed,

  PHOTOCRAFT_COMMANDS,
  PHOTOCRAFT_COMMAND_COUNT,
  isPhotocraftCommand,
  photocraftCommandEntry,
  listPhotocraftCommands,

  isPlainObject,
  clipText,
  cleanTitle,
  normalizeVisibility,
  isValidPhotocraftId,
  requirePhotocraftId,
  normalizeMemberIds,
  assertPhotocraftSize,
  decodeContentBytes,

  canViewProject,
  canEditProject,
  buildProjectSummary,

  WELCOME_TEXT_PATCHES,
  replaceEqualLengthUtf8,
  patchPhotoCraftWasm,
  photoCraftWorkspaceRuntime,
};
