"use strict";
/**
 * 媒体 → OpenArc 资源库登记桥（短剧出图 / 渲染成片导出共用）。
 *
 * 为什么需要这一层：
 *   · 短剧画面先落在 DX 虚拟文件树（dxos-fs），用户在其他地方看不到；按
 *     resourceService.importManaged 的既有唯一入口把字节再登记进资源库，
 *     分镜记录保存 resourceRef，资源库 / 素材库即可读（同一份 content_objects 去重）。
 *   · 导出成片到资源库同样复用这一条，不新造第二套存储。
 *
 * 幂等：按 sha256(内容)+size 查询既有 active 资源；同一用户 / 组织命中即复用，
 * 不重复插入 resource_registry 行（resourceStore.resourceByChecksum 为只读查询）。
 *
 * 依赖注入：{ resourceService, resourceStore, identity, tempDir, clock }
 *   · resourceService.importManaged 缺失 → registrar 返回 null（调用方保持"资源库未装配"的如实降级）。
 *   · identity 仅用于去重时确认 owner / organization；缺失时跳过复用、直接导入。
 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createHash, randomUUID } = require("node:crypto");

const MIME_EXT = Object.freeze({
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "video/mp4": ".mp4",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
});

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function safeResourceName(value, fallback) {
  const raw = String(value == null ? "" : value).trim().replace(/[\\/]+/g, "_");
  const cleaned = raw.replace(CONTROL_CHARS, "").trim().slice(0, 160);
  return cleaned || fallback;
}

function createMediaResourceRegistrar({ resourceService = null, resourceStore = null, identity = null, tempDir = null, clock = null } = {}) {
  if (!resourceService || typeof resourceService.importManaged !== "function") return null;
  const now = typeof clock === "function" ? clock : () => Date.now();
  const scratch = tempDir ? String(tempDir) : path.join(os.tmpdir(), "openarc-media-resources");

  function ownerOf(context) {
    if (!identity || typeof identity.validateSession !== "function") return null;
    try {
      const session = identity.validateSession(context && context.sessionRef, { sensitive: false });
      return session && session.ok && session.user ? { id: String(session.user.id), organizationId: session.user.team_id == null ? null : String(session.user.team_id) } : null;
    } catch { return null; }
  }

  function existingFor(checksum, size, owner) {
    if (!owner || !resourceStore || typeof resourceStore.resourceByChecksum !== "function") return null;
    try {
      const row = resourceStore.resourceByChecksum(checksum, size);
      if (!row || row.registry_status !== "active" || row.trash_state !== "ACTIVE") return null;
      if (String(row.owner_user_id || "") !== owner.id) return null;
      if (owner.organizationId != null && String(row.organization_id || "") !== owner.organizationId) return null;
      return row;
    } catch { return null; }
  }

  function resultFromRow(row, checksum, size, dedupe) {
    const resourceId = String(row.resource_id || "");
    if (!resourceId) return { ok: false, error: "IMPORT_FAILED" };
    return {
      ok: true,
      dedupe: dedupe === true,
      resourceId,
      resourceRef: "resource://" + resourceId,
      checksum,
      size,
    };
  }

  /**
   * 把一段字节登记进资源库（唯一入口：resourceService.importManaged）。
   * 返回 { ok:true, resourceId, resourceRef, checksum, size, dedupe } 或 { ok:false, error, detail? }；
   * 业务失败不抛异常 —— 调用方（出图 / 导出）可以继续，但必须把失败如实写进结果。
   */
  async function registerBuffer({ context = null, buffer, name, mime = "application/octet-stream", description = "", resourceType = "image", tags = [], generated = null } = {}) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) return { ok: false, error: "INVALID_INPUT", detail: "buffer" };
    const checksum = createHash("sha256").update(buffer).digest("hex");
    const size = buffer.length;
    const owner = ownerOf(context);
    const existing = existingFor(checksum, size, owner);
    if (existing) return resultFromRow(existing, checksum, size, true);

    const safeName = safeResourceName(name, resourceType === "video" ? "render.mp4" : "image.png");
    const extension = MIME_EXT[String(mime).toLowerCase()] || (resourceType === "video" ? ".mp4" : ".bin");
    let tempFile = null;
    try {
      fs.mkdirSync(scratch, { recursive: true });
      tempFile = path.join(scratch, "media-resource-" + randomUUID() + extension);
      fs.writeFileSync(tempFile, buffer, { mode: 0o600 });
      const imported = await resourceService.importManaged({
        // 与既有画布素材 / App 导入同一 app principal（resource-library 拥有完整资源基线权限）。
        context: Object.assign({}, context || {}, { appId: "resource-library", source: "media" }),
        sourcePath: tempFile,
        name: safeName,
        description: String(description || "").slice(0, 4000),
        resourceType,
        mimeType: String(mime || ""),
        scope: "PERSONAL",
        tags: Array.isArray(tags) ? tags.slice(0, 16).map(String) : [],
        source: "generated",
        generated: generated && typeof generated === "object" ? generated : null,
      });
      if (!imported || imported.ok !== true) {
        return { ok: false, error: (imported && imported.error) || "IMPORT_FAILED", detail: imported && imported.detail };
      }
      const resource = imported.resource || {};
      const resourceId = String(resource.resourceId || "");
      if (!resourceId) return { ok: false, error: "IMPORT_FAILED", detail: "no-ref" };
      return {
        ok: true,
        dedupe: false,
        resourceId,
        resourceRef: String(resource.resourceRef || "resource://" + resourceId),
        checksum,
        size,
        jobId: imported.jobId || null,
        registeredAt: now(),
      };
    } catch (error) {
      return { ok: false, error: String((error && error.code) || "IMPORT_FAILED"), detail: String((error && error.message) || error).slice(0, 300) };
    } finally {
      if (tempFile) { try { fs.rmSync(tempFile, { force: true }); } catch { /* 临时文件清理失败不覆盖业务结果 */ } }
    }
  }

  return Object.freeze({ registerBuffer });
}

module.exports = { createMediaResourceRegistrar, safeResourceName };
