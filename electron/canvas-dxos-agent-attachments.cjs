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
      error = "当前构建未包含 " + extension + " 解析依赖，请把内容另存为文本/CSV/Markdown 后重新挂载";
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
   * @param files [{ name, mime, size?, buffer }]
   */
  async mount({ context, canvasId, files = [], runId = null } = {}) {
    const loaded = this.#load(context, canvasId);
    if (!loaded.ok) return loaded;
    if (!loaded.canvas.access || !loaded.canvas.access.canEdit) return fail("READ_ONLY", loaded.canvas.access ? loaded.canvas.access.source : null);
    const extracted = extractAttachments(files);
    if (!extracted.ok) return extracted;
    let revision = Number(loaded.canvas.revision || 1);
    const mounted = [];
    for (const attachment of extracted.attachments) {
      const buffer = attachment.buffer;
      if (!buffer || !buffer.length) continue;
      const imported = await this.#importBytes({ context, buffer, name: attachment.name, mime: attachment.mime });
      if (!imported.ok) return imported;
      const resourceRef = imported.resourceRef;
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
      if (!applied.ok) return applied;
      revision = Number(applied.canvas.revision);
      const nodeId = applied.result && applied.result.node ? applied.result.node.id : null;
      const row = this.store.insertAttachment({
        id: attachmentId(), canvasId, nodeId, resourceRef, name: attachment.name, mime: attachment.mime,
        bytes: buffer.byteLength, contentChars: attachment.content.length, truncated: attachment.truncated,
        parseError: attachment.error || null, runId, mountedBy: loaded.user.id,
      });
      mounted.push(this.#view(row));
    }
    return ok({ attachments: mounted, revision });
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
  MAX_ATTACHMENT_TEXT_CHARS, MAX_TOTAL_CHARS, MAX_ATTACHMENT_FILES, MAX_ATTACHMENT_BYTES,
  TEXT_EXTENSIONS, BINARY_PARSERS_UNAVAILABLE,
};
