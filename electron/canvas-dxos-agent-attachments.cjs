/**
 * B5c · Agent 附件（源 server/canvasAgentAttachments.ts，104 行）与"挂载到画布"语义。
 *
 * 源只做一件事：把上传文件**抽取成文本**给 Agent 读（源 :80-104）：
 *   · 文本类按 UTF-8/UTF-16 BOM 解码 ← 源 :23-34
 *   · docx 用 adm-zip 抽 word/document.xml ← 源 :47-52
 *   · xlsx/xlsm/csv 用 exceljs ← 源 :54-72
 *   · PDF / 其它二进制给出明确错误文案 ← 源 :91-93
 *   · 单文件上限 40k 字符 ← 源 :5；整体 80k 字符预算 ← 源 index.ts:3814-3819
 *   · multer 上限 12 文件 × 20 MB ← 源 index.ts:3797-3800
 *
 * 本仓差异（不新增依赖）：
 *   · adm-zip / exceljs **不在 package.json 且硬约束禁止新增**，因此 .docx/.xlsx 一律返回
 *     结构化 parseError（"当前构建未包含该解析依赖"），**不做假解析**；文本/CSV/JSON/代码照常。
 *   · "挂载到画布"是本仓新增语义：抽取后的文本连同原始字节一起导入资源域（不建第二套存储），
 *     再经既有 canvas-domain.node.add 落到画布节点，卸载走 node.delete。
 *   · 云与商业化（dxosProtocol / apiQuota / cloudEntitlement / publicMedia / api.dx-os.com）
 *     在本文件零引用。
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { inflateRawSync } = require("node:zlib");

const MAX_ATTACHMENT_TEXT_CHARS = 40000;   // 源 canvasAgentAttachments.ts:5
const MAX_TOTAL_CHARS = 80000;             // 源 index.ts:3814
const MAX_ATTACHMENT_FILES = 12;           // 源 index.ts:3799
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** 源 canvasAgentAttachments.ts:76 的文本类扩展名。 */
const TEXT_EXTENSIONS = Object.freeze([
  ".txt", ".md", ".markdown", ".json", ".jsonl", ".csv", ".tsv", ".log", ".xml", ".yaml", ".yml",
  ".html", ".css", ".js", ".jsx", ".ts", ".tsx", ".vue", ".py", ".java", ".c", ".cc", ".cpp", ".h", ".hpp",
  ".sql", ".ini", ".toml",
]);
const BINARY_PARSERS_UNAVAILABLE = Object.freeze([".docx", ".xlsx", ".xlsm"]);

/**
 * task-25 A18：docx/xlsx 解析器注入。宿主若已有等价依赖（如外部文档服务）可通过
 * configureAttachmentParsers({ docx: (buffer, name) => string, xlsx: ... }) 注入；
 * 未注入时保持原有结构化 parseError（不新增重依赖、不做假解析）。
 */
let injectedParsers = Object.freeze({});
function configureAttachmentParsers(parsers) {
  injectedParsers = parsers && typeof parsers === "object" ? Object.freeze({ ...parsers }) : Object.freeze({});
  return injectedParsers;
}
/**
 * task-36 A18：默认使用零依赖解析器；宿主注入同扩展名解析器时优先注入（可覆盖默认）。
 * 解析器抛错由 extractAttachment 统一转成结构化“文件解析失败”。
 */
function parserFor(extension) {
  if (extension === ".docx") return typeof injectedParsers.docx === "function" ? injectedParsers.docx : parseDocxText;
  if (extension === ".xlsx" || extension === ".xlsm") return typeof injectedParsers.xlsx === "function" ? injectedParsers.xlsx : parseXlsxText;
  return null;
}

// ---------------------------------------------------------------------------
// task-36 A18：零依赖 ZIP + XML 最小解析（node:zlib，不新增 adm-zip/exceljs）。
// 只支持 stored/deflate、单层 ZIP（DOCX/XLSX 的标准结构），有总量上限；加密/ZIP64 明确报错。
// ---------------------------------------------------------------------------
const MAX_ZIP_ENTRIES = 512;
const MAX_ZIP_OUTPUT = 64 * 1024 * 1024;

function readZipEntries(buffer) {
  const source = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (source.length < 22 || source.readUInt32LE(0) !== 0x04034b50) {
    // 允许带任意前缀的 ZIP（docx 通常从 0 开始；这里只按 EOCD 定位，不做自解压）
  }
  let eocd = -1;
  for (let i = source.length - 22; i >= Math.max(0, source.length - 65557); i -= 1) {
    if (source.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("ZIP 缺少中央目录");
  const count = source.readUInt16LE(eocd + 10);
  const centralOffset = source.readUInt32LE(eocd + 16);
  if (count > MAX_ZIP_ENTRIES) throw new Error("ZIP 条目过多");
  const entries = new Map();
  let offset = centralOffset;
  let total = 0;
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > source.length || source.readUInt32LE(offset) !== 0x02014b50) throw new Error("ZIP 中央目录损坏");
    const method = source.readUInt16LE(offset + 10);
    const compressedSize = source.readUInt32LE(offset + 20);
    const uncompressedSize = source.readUInt32LE(offset + 24);
    const nameLength = source.readUInt16LE(offset + 28);
    const extraLength = source.readUInt16LE(offset + 30);
    const commentLength = source.readUInt16LE(offset + 32);
    const localOffset = source.readUInt32LE(offset + 42);
    const name = source.slice(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (uncompressedSize > MAX_ZIP_OUTPUT || total + uncompressedSize > MAX_ZIP_OUTPUT) throw new Error("ZIP 解压超过上限");
    if (localOffset + 30 > source.length || source.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("ZIP 本地头损坏");
    const localNameLength = source.readUInt16LE(localOffset + 26);
    const localExtraLength = source.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = source.slice(dataStart, dataStart + compressedSize);
    let data;
    if (method === 0) data = compressed;
    else if (method === 8) data = inflateRawSync(compressed, { maxOutputLength: MAX_ZIP_OUTPUT });
    else throw new Error("ZIP 压缩方式不支持：" + method);
    entries.set(name, data);
    total += data.length;
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function decodeXmlText(xml) {
  return String(xml || "")
    .replace(/<w:tab\s*\/>/g, "\t")
    .replace(/<w:br\s*\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<\/a:p>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/g, "&");
}

function parseDocxText(buffer) {
  const entries = readZipEntries(buffer);
  const xml = entries.get("word/document.xml");
  if (!xml) throw new Error("DOCX 缺少 word/document.xml");
  return decodeXmlText(xml.toString("utf8")).replace(/\n{3,}/g, "\n\n").trim();
}

function parseXlsxText(buffer) {
  const entries = readZipEntries(buffer);
  const sharedXml = entries.get("xl/sharedStrings.xml");
  const shared = [];
  if (sharedXml) {
    const text = sharedXml.toString("utf8");
    for (const match of text.matchAll(/<si[^>]*>([\s\S]*?)<\/si>/g)) shared.push(decodeXmlText(match[1]).replace(/\n/g, " ").trim());
  }
  const sheets = [...entries.keys()].filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).sort();
  if (!sheets.length) throw new Error("XLSX 缺少 worksheet");
  const lines = [];
  for (const sheet of sheets) {
    const xml = entries.get(sheet).toString("utf8");
    for (const rowMatch of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const cellMatch of rowMatch[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
        const attrs = cellMatch[1] || "";
        const inner = cellMatch[2] || "";
        const valueMatch = /<v[^>]*>([\s\S]*?)<\/v>/.exec(inner);
        const inlineMatch = /<is[^>]*>([\s\S]*?)<\/is>/.exec(inner);
        if (/t="s"/.test(attrs) && valueMatch) cells.push(shared[Number(valueMatch[1])] || "");
        else if (inlineMatch) cells.push(decodeXmlText(inlineMatch[1]).trim());
        else if (valueMatch) cells.push(decodeXmlText(valueMatch[1]).trim());
        else cells.push("");
      }
      if (cells.some((cell) => cell !== "")) lines.push(cells.join("\t"));
    }
  }
  return lines.join("\n").trim();
}

function parseOfficeText(buffer, extension) {
  if (extension === ".docx") return parseDocxText(buffer);
  if (extension === ".xlsx" || extension === ".xlsm") return parseXlsxText(buffer);
  return null;
}

const ok = (extra = {}) => ({ ok: true, ...extra });
const fail = (error, detail = null) => ({ ok: false, error: String(error), detail });
const attachmentId = () => "caa_" + Date.now().toString(36) + "_" + crypto.randomBytes(4).toString("hex");

const extensionOf = (name) => { const m = /(\.[A-Za-z0-9]+)$/.exec(String(name || "")); return m ? m[1].toLowerCase() : ""; };

/** 源 :23-34：UTF-16 BOM 处理 + UTF-8 BOM 去除。 */
function decodeText(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString("utf16le");
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.allocUnsafe(buffer.length - 2);
    for (let index = 2; index + 1 < buffer.length; index += 2) {
      swapped[index - 2] = buffer[index + 1];
      swapped[index - 1] = buffer[index];
    }
    return swapped.toString("utf16le");
  }
  return buffer.toString("utf8").replace(/^\uFEFF/, "");
}

/** 源 :74-78。 */
function isTextLike(name, mime, extension) {
  return mime.startsWith("text/") || mime === "application/json" || mime === "application/xml"
    || TEXT_EXTENSIONS.includes(extension)
    || (!mime && !extension && String(name || "").length > 0);
}

/**
 * 源 :80-104 的等价实现（去掉 adm-zip / exceljs 两条依赖路径）。
 * @returns {{name, mime, size, content, truncated, error?}}
 */
function extractAttachment(input = {}) {
  const buffer = Buffer.isBuffer(input.buffer) ? input.buffer : Buffer.from(input.buffer || []);
  const name = String(input.name || "未命名文件").slice(0, 300);
  const mime = String(input.mime || "application/octet-stream").split(";")[0].toLowerCase();
  const extension = extensionOf(name);
  let content = "";
  let error = "";
  try {
    if (BINARY_PARSERS_UNAVAILABLE.includes(extension)) {
      // task-36 A18：默认零依赖 ZIP+XML；注入解析器优先覆盖。损坏包/损坏 XML 一律结构化。
      const parser = parserFor(extension);
      if (!parser) {
        error = "当前构建未包含 " + extension + " 解析依赖，请把内容另存为文本/CSV/Markdown 后重新挂载";
      } else {
        try {
          const parsed = parser(buffer, name);
          if (parsed && typeof parsed === "object" && typeof parsed.text === "string") content = parsed.text;
          else if (typeof parsed === "string") content = parsed;
          else error = "解析器没有返回文本";
        } catch (cause) {
          error = "文件解析失败：" + String((cause && cause.message) || cause);
        }
      }
    } else if (extension === ".csv" || extension === ".tsv" || mime === "text/csv") {
      content = decodeText(buffer);
    } else if (isTextLike(name, mime, extension)) {
      content = decodeText(buffer);
    } else if (extension === ".pdf" || mime === "application/pdf") {
      error = "当前版本暂不解析 PDF 正文，请将 PDF 内容复制为文本或转换为 DOCX 后上传";
    } else {
      error = "该文件是二进制格式，当前不能作为文本读取";
    }
  } catch (cause) {
    error = "文件解析失败：" + String((cause && cause.message) || cause);
  }
  content = content.replace(/\0/g, "").trim();
  const truncated = content.length > MAX_ATTACHMENT_TEXT_CHARS;
  return {
    name, mime, size: Number(input.size) || buffer.byteLength,
    content: content.slice(0, MAX_ATTACHMENT_TEXT_CHARS), truncated,
    ...(error ? { error } : {}),
  };
}

/** 源 index.ts:3815-3819：整体字符预算按顺序分配。 */
function extractAttachments(files) {
  const list = (Array.isArray(files) ? files : []).slice(0, MAX_ATTACHMENT_FILES);
  if (!list.length) return fail("INVALID_INPUT", "no-files");
  for (const file of list) if ((file.buffer ? file.buffer.byteLength : 0) > MAX_ATTACHMENT_BYTES) return fail("LIMIT_EXCEEDED", "20MB");
  let remaining = MAX_TOTAL_CHARS;
  return ok({
    attachments: list.map((file) => {
      const extracted = extractAttachment(file);
      const content = extracted.content.slice(0, Math.max(0, remaining));
      remaining -= content.length;
      return { ...extracted, content, truncated: extracted.truncated || content.length < extracted.content.length, buffer: file.buffer };
    }),
  });
}

class CanvasAgentAttachmentService {
  constructor({ identity, store, canvasService = null, resourceService = null, tempDir = null, clock = null } = {}) {
    if (!identity || !store) throw new Error("CanvasAgentAttachmentService 需要 identity 与 store");
    this.identity = identity;
    this.store = store;
    this.canvasService = canvasService;
    this.resourceService = resourceService;
    this.tempDir = tempDir;
    this.clock = typeof clock === "function" ? clock : () => Date.now();
  }

  #actor(context) {
    const view = this.identity.validateSession(context && context.sessionRef, { sensitive: false });
    if (!view || !view.ok) return fail("NOT_FOUND_OR_FORBIDDEN");
    return ok({ user: view.user });
  }

  #view(row) {
    return {
      attachmentId: row.id, canvasId: row.canvas_id, nodeId: row.node_id,
      ref: row.resource_ref ? "openarc-asset:" + row.resource_ref : null,
      name: row.name, mime: row.mime, bytes: Number(row.bytes || 0),
      contentChars: Number(row.content_chars || 0), truncated: !!row.truncated,
      ...(row.parse_error ? { parseError: row.parse_error } : {}),
      ...(row.run_id ? { runId: row.run_id } : {}),
      mountedBy: row.mounted_by, createdAt: Number(row.created_at || 0),
      removedAt: row.removed_at == null ? null : Number(row.removed_at), mounted: row.removed_at == null,
    };
  }

  list({ context, canvasId, includeRemoved = false } = {}) {
    const loaded = this.#load(context, canvasId);
    if (!loaded.ok) return loaded;
    return ok({ attachments: this.store.attachmentsOfCanvas(String(canvasId), !!includeRemoved).map((row) => this.#view(row)) });
  }

  #load(context, canvasId) {
    const actor = this.#actor(context);
    if (!actor.ok) return actor;
    if (!this.canvasService || typeof this.canvasService.getCanvas !== "function") return fail("CANVAS_UNAVAILABLE");
    const view = this.canvasService.getCanvas({ context, canvasId });
    if (!view || !view.ok) return view && view.error ? view : fail("NOT_FOUND");
    return ok({ user: actor.user, canvas: view.canvas });
  }

  async #importBytes({ context, buffer, name, mime }) {
    if (!this.resourceService || typeof this.resourceService.importManaged !== "function") return fail("RESOURCE_UNAVAILABLE");
    const dir = typeof this.tempDir === "function" ? this.tempDir() : (this.tempDir || path.join(os.tmpdir(), "openarc-canvas-dxos"));
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
    const safe = String(name).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "agent-attachment";
    const file = path.join(dir, "agent-attachment-" + Date.now().toString(36) + "-" + safe);
    fs.writeFileSync(file, buffer);
    try {
      const imported = await this.resourceService.importManaged({
        context: { ...context, appId: "resource-library" }, sourcePath: file, name: safe, mimeType: mime || null, scope: "PERSONAL", source: "agent",
      });
      if (!imported || !imported.ok) return imported && imported.error ? imported : fail("IMPORT_FAILED");
      const ref = imported.resource && (imported.resource.resourceId || imported.resource.resourceRef);
      if (!ref) return fail("IMPORT_FAILED", "no-ref");
      return ok({ resourceRef: String(ref).replace(/^resource:\/\//, "").replace(/^openarc-asset:/, "") });
    } finally {
      try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
    }
  }

  /**
   * 挂载：源 index.ts:3802-3823 的抽取 + 本仓的画布节点落地。
   *
   * 可靠性：多附件必须**全成或全回滚**，不留"挂了一半"的节点与附件行。
   *   ① 先把所有字节导入资源域（异步独立事务）。失败发生在任何附件行 / 画布节点之前，
   *      detail 带第几个附件与缺失依赖（stage=import）；
   *   ② 再把"画布节点 + 附件行"放进同一个 BEGIN IMMEDIATE 事务。canvas-store.transactSync
   *      在本仓不是可重入的（identity.transactSync 直接 BEGIN），故事务期间临时把它换成
   *      "已在事务内就直接跑"，结束后按原样还原 —— 沿用 agent-task-store.cjs:138 / media-store.cjs:125
   *      的 writeTransaction 重入口径。任一步失败整事务 ROLLBACK（stage=apply / commit）。
   *
   * 资源域对象是独立于本事务的（与 canvas-dxos-commands.cjs package/import 的失败回滚同一口径：
   * 资源对象交由资源域 GC，不在画布域硬删）；本事务保证附件行与画布节点全成或全回滚。
   *
   * @param files [{ name, mime, size?, buffer }]
   */
  async mount({ context, canvasId, files = [], runId = null } = {}) {
    const loaded = this.#load(context, canvasId);
    if (!loaded.ok) return loaded;
    if (!loaded.canvas.access || !loaded.canvas.access.canEdit) return fail("READ_ONLY", loaded.canvas.access ? loaded.canvas.access.source : null);
    const extracted = extractAttachments(files);
    if (!extracted.ok) return extracted;
    // sourceIndex 是"用户传进来的第几个附件"（空 buffer 会被跳过，但报错仍要指回原始序号）。
    const usable = [];
    for (let index = 0; index < extracted.attachments.length; index += 1) {
      const attachment = extracted.attachments[index];
      if (attachment.buffer && attachment.buffer.length) usable.push({ attachment, sourceIndex: index + 1 });
    }
    const staged = [];
    for (const { attachment, sourceIndex } of usable) {
      const imported = await this.#importBytes({ context, buffer: attachment.buffer, name: attachment.name, mime: attachment.mime });
      if (!imported.ok) {
        const dependency = imported.detail && imported.detail.dependency ? imported.detail.dependency
          : imported.error === "RESOURCE_UNAVAILABLE" ? "resourceService"
            : imported.error === "IMPORT_FAILED" ? "resourceService.importManaged" : null;
        return fail(imported.error || "IMPORT_FAILED", {
          stage: "import", attachmentIndex: sourceIndex, attachmentName: attachment.name,
          ...(dependency ? { dependency } : {}), reason: imported.detail == null ? null : imported.detail,
        });
      }
      staged.push({ attachment, resourceRef: imported.resourceRef, sourceIndex });
    }
    if (!staged.length) return ok({ attachments: [], revision: Number(loaded.canvas.revision || 1) });

    const db = this.store.db;
    const canvasStore = this.canvasService && this.canvasService.store ? this.canvasService.store : null;
    // 只有同一条连接才能把内层事务并进外层；不同连接时保持原样（内层会各自提交，但那种装配本就不成立）。
    const shareTransaction = !!canvasStore && !!canvasStore.identity && canvasStore.identity.connection === db;
    const hadOwnTransact = shareTransaction ? Object.prototype.hasOwnProperty.call(canvasStore, "transactSync") : false;
    const originalTransact = shareTransaction ? canvasStore.transactSync : null;
    if (shareTransaction) canvasStore.transactSync = (work) => work();

    let revision = Number(loaded.canvas.revision || 1);
    const mounted = [];
    try {
      db.exec("BEGIN IMMEDIATE");
      for (const { attachment, resourceRef, sourceIndex } of staged) {
        const nodeType = attachment.mime.startsWith("image/") ? "image" : attachment.mime.startsWith("video/") ? "video" : attachment.error ? "output" : "prompt";
        const applied = this.canvasService.applyCommand({
          context, canvasId, baseRevision: revision,
          command: {
            type: "node.add",
            node: {
              type: nodeType, x: 0, y: 0, name: attachment.name, mediaKind: nodeType === "image" || nodeType === "video" ? nodeType : "file",
              ...(nodeType === "prompt" ? { text: attachment.content.slice(0, 4000) } : {}),
              refs: ["openarc-asset:" + resourceRef],
            },
          },
          actorKind: "AGENT",
        });
        if (!applied.ok) {
          try { db.exec("ROLLBACK"); } catch { /* 已回滚 */ }
          return fail(applied.error || "APPLY_FAILED", {
            stage: "apply", attachmentIndex: sourceIndex, attachmentName: attachment.name,
            reason: applied.detail == null ? null : applied.detail,
          });
        }
        revision = Number(applied.canvas.revision);
        const nodeId = applied.result && applied.result.node ? applied.result.node.id : null;
        const row = this.store.insertAttachment({
          id: attachmentId(), canvasId, nodeId, resourceRef, name: attachment.name, mime: attachment.mime,
          bytes: attachment.buffer.byteLength, contentChars: attachment.content.length, truncated: attachment.truncated,
          parseError: attachment.error || null, runId, mountedBy: loaded.user.id,
        });
        mounted.push(this.#view(row));
      }
      db.exec("COMMIT");
      return ok({ attachments: mounted, revision });
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* 已回滚 */ }
      return fail("MOUNT_ROLLBACK", { stage: "commit", reason: String((error && error.message) || error) });
    } finally {
      if (shareTransaction) {
        if (hadOwnTransact) canvasStore.transactSync = originalTransact;
        else delete canvasStore.transactSync;
      }
    }
  }

  /** 卸载：走既有 node.delete（画布 revision 前进），附件行标记 removed_at（资源本身保留）。 */
  unmount({ context, canvasId, attachmentId: id } = {}) {
    const loaded = this.#load(context, canvasId);
    if (!loaded.ok) return loaded;
    const row = this.store.attachmentById(id);
    if (!row || row.canvas_id !== String(canvasId)) return fail("NOT_FOUND");
    if (row.removed_at) return ok({ attachment: this.#view(row), alreadyRemoved: true });
    if (!loaded.canvas.access || !loaded.canvas.access.canEdit) return fail("READ_ONLY", loaded.canvas.access ? loaded.canvas.access.source : null);
    const nodeExists = row.node_id && (loaded.canvas.doc.nodes || []).some((node) => node.id === row.node_id);
    if (nodeExists) {
      const applied = this.canvasService.applyCommand({
        context, canvasId, baseRevision: Number(loaded.canvas.revision || 1),
        command: { type: "node.delete", ids: [row.node_id] }, actorKind: "AGENT",
      });
      if (!applied.ok) return applied;
    }
    const removed = this.store.markAttachmentRemoved(row.id);
    return ok({ attachment: this.#view(removed), removedNode: !!nodeExists });
  }
}

module.exports = {
  CanvasAgentAttachmentService, extractAttachment, extractAttachments, decodeText, isTextLike, extensionOf,
  configureAttachmentParsers, parseDocxText, parseXlsxText, readZipEntries,
  MAX_ATTACHMENT_TEXT_CHARS, MAX_TOTAL_CHARS, MAX_ATTACHMENT_FILES, MAX_ATTACHMENT_BYTES,
  TEXT_EXTENSIONS, BINARY_PARSERS_UNAVAILABLE,
};
