/**
 * B5c · 素材库（源 server/canvasAssetLibrary.ts，268 行）。
 *
 * 复用既有资源域，**不建第二套素材系统**：
 *   · 素材字节只进 resource_* 表（resourceService.importManaged → content_objects / library_resources
 *     / resource_registry）；本模块只存"条目索引 + 元数据"。
 *   · 去重先比对 library_resources.checksum（源无此能力，是本仓对既有资源域的复用）：
 *     同一份字节重复导入 → 复用同一个 ResourceRef，不产生第二份内容对象。
 *   · 条目身份沿用 ResourceRef（openarc-asset:res_xxx），与画布节点 url、canvas-service.readAsset
 *     同一口径（源用 fs nodeId，见 canvasAssetLibrary.ts:90-100）。
 *
 * 与源的逐条对应：
 *   · ensureCanvasAssetLibrary / 系统提示词播种 ← 源 :51-75 + shared/canvasAssetLibrary.ts:7-22
 *   · list/get ← 源 :77-88
 *   · upsertCanvasAssetLibraryItem（三种 kind、字段清洗、prompt 版本历史） ← 源 :144-244
 *   · deleteCanvasAssetLibraryItem（系统提示词不可删） ← 源 :246-255
 *   · canvasAssetLibraryAccess ← 源 :263-268（这里用 owner + ORGANIZATION 可见性表达 read/edit）
 *   · 云的分享成员 setCanvasAssetLibraryMembers（源 :257-261 走 developerCollabProjects，含 public/cloud）
 *     **不引入**：本域只做 owner / 组织可见两档，云与商业化（dxosProtocol / apiQuota / cloudEntitlement
 *     / publicMedia / api.dx-os.com）一律不出现。
 */
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const LIBRARY_FORMAT = "dx-canvas-asset-library/v1";
const DEFAULT_NAME = "我的资产库";
const MAX_ITEMS = 1000;
const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const ITEM_KINDS = Object.freeze(["asset", "prompt", "workflow"]);
const PROMPT_ROLES = Object.freeze(["image-describe", "prompt-polish"]);

/** 源 shared/canvasAssetLibrary.ts:7-22 的两条系统推理提示词（不可删除，只能改内容或换 Skill）。 */
const CANVAS_SYSTEM_PROMPT_TEMPLATES = Object.freeze([
  {
    role: "image-describe",
    title: "系统 · 图片提示词反推",
    prompt: "你是专业的视觉提示词反推专家。请仔细分析输入图片的主体、人物或物体特征、环境、构图、镜头、光线、色彩、材质、风格、氛围与关键细节，整理为可直接用于图像生成或图像编辑模型的高质量中文提示词。忠实描述可见内容，不虚构品牌、文字或不可见细节；只输出最终提示词，不要解释分析过程。",
  },
  {
    role: "prompt-polish",
    title: "系统 · 生成提示词润色",
    prompt: "你是专业的生成式媒体提示词导演。请在不改变用户核心意图的前提下，把简短需求扩写为信息丰富、结构清晰、可直接执行的中文提示词，补足主体特征、动作、场景、构图、镜头、光线、色彩、材质、风格、氛围和必要约束。若提供了图片，必须逐张理解图片内容和用途，准确处理主体、场景、风格与版式之间的关系；不得把参考图中无关的品牌、文字、人物身份或商品特征错误迁移到目标图。只输出润色后的最终提示词，不要解释分析过程。",
  },
]);

const ok = (extra = {}) => ({ ok: true, ...extra });
const fail = (error, detail = null) => ({ ok: false, error: String(error), detail });
const str = (value, max = 200) => (typeof value === "string" ? value.slice(0, max) : "");
const clampText = (value, max = 80000) => (typeof value === "string" ? value.trim().slice(0, max) : "");
const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");
const itemId = () => "cai_" + Date.now().toString(36) + "_" + crypto.randomBytes(4).toString("hex");
const libraryId = () => "cal_" + Date.now().toString(36) + "_" + crypto.randomBytes(4).toString("hex");

function tagList(value) {
  const list = Array.isArray(value) ? value : [];
  return [...new Set(list.map((tag) => String(tag).trim()).filter(Boolean))].slice(0, 24).map((tag) => tag.slice(0, 60));
}

function mimeKind(mime, name) {
  const m = String(mime || "").toLowerCase();
  const signature = (m + " " + String(name || "")).toLowerCase();
  if (m.startsWith("image/") || /\.(png|jpe?g|webp|gif|avif)$/.test(signature)) return "image";
  if (m.startsWith("video/") || /\.(mp4|webm|mov|m4v|mkv|avi)$/.test(signature)) return "video";
  if (m.startsWith("audio/") || /\.(mp3|wav|m4a|aac|flac)$/.test(signature)) return "audio";
  return "file";
}

function resourceTypeOf(mime, name) {
  const kind = mimeKind(mime, name);
  return kind === "image" ? "image" : kind === "video" ? "video" : kind === "audio" ? "audio" : "file";
}

class CanvasAssetLibraryService {
  constructor({ identity, store, resourceService = null, resourceStore = null, canvasService = null, tempDir = null, clock = null, logger = null } = {}) {
    if (!identity || !store) throw new Error("CanvasAssetLibraryService 需要 identity 与 store");
    this.identity = identity;
    this.store = store;
    this.resourceService = resourceService;
    this.resourceStore = resourceStore;
    this.canvasService = canvasService;
    this.tempDir = tempDir;
    this.clock = typeof clock === "function" ? clock : () => Date.now();
    this.logger = logger;
  }

  // ---------------------------------------------------------------- 内部

  #actor(context) {
    const view = this.identity.validateSession(context && context.sessionRef, { sensitive: false });
    if (!view || !view.ok) return fail("NOT_FOUND_OR_FORBIDDEN");
    return ok({ user: view.user });
  }

  #now() { return Number(this.clock()); }

  /** 源 :263-268 的等价：owner 可编辑；组织可见库对其余成员只读。 */
  #access(library, user) {
    if (!library) return null;
    if (library.owner_user_id === user.id) return { level: "owner", canEdit: true, canView: true };
    if (library.visibility === "ORGANIZATION" && library.organization_id === user.team_id) return { level: "read", canEdit: false, canView: true };
    return null;
  }

  #load(context, libraryId, { needEdit = false } = {}) {
    const actor = this.#actor(context);
    if (!actor.ok) return actor;
    const library = libraryId ? this.store.libraryById(libraryId) : null;
    if (!library || library.deleted_at) return fail("NOT_FOUND");
    const access = this.#access(library, actor.user);
    if (!access) return fail("NOT_FOUND_OR_FORBIDDEN");
    if (needEdit && !access.canEdit) return fail("READ_ONLY", access.level);
    return ok({ library, user: actor.user, access });
  }

  #libraryView(library, access) {
    return {
      id: library.id,
      name: library.name,
      ownerId: library.owner_user_id,
      organizationId: library.organization_id,
      format: library.format,
      visibility: library.visibility,
      version: Number(library.version || 1),
      access: access ? (access.canEdit ? "owner" : "read") : "read",
      itemCount: this.store.countItems(library.id),
      updatedAt: Number(library.updated_at || 0),
      createdAt: Number(library.created_at || 0),
    };
  }

  #itemView(row) {
    const resourceRef = row.resource_ref || null;
    return {
      id: row.id,
      libraryId: row.library_id,
      kind: row.kind,
      title: row.title,
      ...(row.group_name ? { group: row.group_name } : {}),
      prompt: row.prompt || "",
      ...(row.model ? { model: row.model } : {}),
      ...(row.category ? { category: row.category } : {}),
      ...(row.source ? { source: row.source } : {}),
      ...(row.source_key ? { sourceKey: row.source_key } : {}),
      tags: JSON.parse(row.tags_json || "[]"),
      ...(row.skill_id ? { skillId: row.skill_id } : {}),
      ...(row.prompt_role ? { promptRole: row.prompt_role } : {}),
      ...(row.media_kind ? { mediaKind: row.media_kind } : {}),
      ...(resourceRef ? { resourceRef: "openarc-asset:" + resourceRef, media: { resourceId: resourceRef, name: row.title, mime: row.mime || "application/octet-stream", kind: row.media_kind || "file", bytes: row.bytes == null ? null : Number(row.bytes) } } : {}),
      ...(row.cover_ref ? { coverRef: "openarc-asset:" + row.cover_ref } : {}),
      ...(row.workflow_json ? { workflow: JSON.parse(row.workflow_json) } : {}),
      ...(row.versions_json ? { versions: JSON.parse(row.versions_json) } : {}),
      referenceCount: resourceRef ? this.store.countResourceRefs(resourceRef) : 0,
      createdBy: row.created_by,
      createdAt: Number(row.created_at || 0),
      updatedAt: Number(row.updated_at || 0),
    };
  }

  // ---------------------------------------------------------------- 素材库

  /** 源 :51-75：一个用户一个默认库，并补齐系统提示词。 */
  ensureDefaultLibrary({ context } = {}) {
    const actor = this.#actor(context);
    if (!actor.ok) return actor;
    const existing = this.store.librariesOwned(actor.user.id).find((row) => row.name === DEFAULT_NAME) || this.store.librariesOwned(actor.user.id)[0];
    const library = existing || this.store.insertLibrary({
      id: libraryId(), organizationId: actor.user.team_id, ownerUserId: actor.user.id,
      name: DEFAULT_NAME, format: LIBRARY_FORMAT, visibility: "PRIVATE",
    });
    const seeded = this.#seedSystemPrompts(library, actor.user.id);
    const access = this.#access(library, actor.user);
    return ok({ library: this.#libraryView(library, access), items: seeded.items.map((row) => this.#itemView(row)) });
  }

  createLibrary({ context, name = DEFAULT_NAME, visibility = "PRIVATE" } = {}) {
    const actor = this.#actor(context);
    if (!actor.ok) return actor;
    const library = this.store.insertLibrary({
      id: libraryId(), organizationId: actor.user.team_id, ownerUserId: actor.user.id,
      name: String(name || DEFAULT_NAME).trim().slice(0, 120) || DEFAULT_NAME,
      format: LIBRARY_FORMAT,
      visibility: String(visibility).toUpperCase() === "ORGANIZATION" ? "ORGANIZATION" : "PRIVATE",
    });
    const seeded = this.#seedSystemPrompts(library, actor.user.id);
    return ok({ library: this.#libraryView(library, this.#access(library, actor.user)), items: seeded.items.map((row) => this.#itemView(row)) });
  }

  /** 源 :77-82：列举本人库 + 组织可见库；顺带补系统提示词。 */
  listLibraries({ context } = {}) {
    const actor = this.#actor(context);
    if (!actor.ok) return actor;
    const seen = new Map();
    for (const row of this.store.librariesOwned(actor.user.id)) {
      const seeded = this.#seedSystemPrompts(row, actor.user.id);
      seen.set(row.id, this.#libraryView(seeded.library, this.#access(seeded.library, actor.user)));
    }
    for (const row of this.store.librariesOrg(actor.user.team_id)) {
      if (seen.has(row.id)) continue;
      seen.set(row.id, this.#libraryView(row, this.#access(row, actor.user)));
    }
    return ok({ libraries: [...seen.values()].sort((a, b) => b.updatedAt - a.updatedAt) });
  }

  getLibrary({ context, libraryId: id } = {}) {
    const loaded = this.#load(context, id);
    if (!loaded.ok) return loaded;
    this.#seedSystemPrompts(loaded.library, loaded.user.id);
    return ok({
      library: this.#libraryView(loaded.library, loaded.access),
      items: this.store.itemsOfLibrary(loaded.library.id).map((row) => this.#itemView(row)),
    });
  }

  #seedSystemPrompts(library, userId) {
    const existing = this.store.itemsOfLibrary(library.id).filter((row) => row.prompt_role);
    const have = new Set(existing.map((row) => row.prompt_role));
    for (const template of CANVAS_SYSTEM_PROMPT_TEMPLATES) {
      if (have.has(template.role)) continue;
      this.store.insertItem({
        id: itemId(), libraryId: library.id, kind: "prompt", title: template.title,
        prompt: template.prompt, promptRole: template.role, mediaKind: "image",
        sourceKey: "system:" + template.role, createdBy: "system", createdAt: this.#now(), updatedAt: this.#now(),
      });
    }
    return { library, items: this.store.itemsOfLibrary(library.id) };
  }

  // ---------------------------------------------------------------- 素材导入（去重）

  /**
   * 导入一份素材（源 :200-216 的 sourceNodeId 分支替换成本仓的资源域导入）。
   * 去重：先按 SHA-256 比对既有 library_resources.checksum；命中即复用同一 ResourceRef。
   * @returns {ok, item, dedupe:{resource:boolean, item:boolean}, referenceCount}
   */
  async importAssetItem({ context, libraryId: id, name = "素材", mime = null, dataUrl = null, base64 = null, sourcePath = null, title = null, group = null, tags = [], sourceKey = null } = {}) {
    const loaded = this.#load(context, id, { needEdit: true });
    if (!loaded.ok) return loaded;
    const bytes = this.#decodeBytes({ dataUrl, base64, sourcePath });
    if (!bytes.ok) return bytes;
    const buffer = bytes.buffer;
    if (!buffer.length) return fail("INVALID_INPUT", "empty");
    if (buffer.length > MAX_ASSET_BYTES) return fail("LIMIT_EXCEEDED", "8MB");
    const resolvedMime = str(mime, 120) || bytes.mime || "application/octet-stream";
    const checksum = sha256(buffer);
    const existing = this.store.resourceByChecksum(checksum, buffer.length);
    const reuse = existing && existing.owner_user_id === loaded.user.id ? existing : null;

    // 条目级去重（源 :176-178 用 id / sourceKey 定位同一个条目）。
    const requestedKey = str(sourceKey, 500) || null;
    const previous = requestedKey ? this.store.itemBySourceKey(loaded.library.id, requestedKey) : null;
    if (previous && previous.resource_ref) {
      return ok({ item: this.#itemView(previous), dedupe: { resource: true, item: true }, referenceCount: this.store.countResourceRefs(previous.resource_ref) });
    }

    let resourceRef = reuse ? String(reuse.resource_id) : null;
    let reusedResource = !!reuse;
    if (!resourceRef) {
      if (!this.resourceService || typeof this.resourceService.importManaged !== "function") return fail("RESOURCE_UNAVAILABLE");
      const imported = await this.#importManagedFile({ context, buffer, name, mime: resolvedMime });
      if (!imported.ok) return imported;
      resourceRef = imported.resourceRef;
      reusedResource = !!imported.dedupe;
    }

    // 同一份素材在同一库里已存在 → 直接复用该条目（不对同一 ResourceRef 建重复条目）。
    const sameRef = this.store.itemByResourceRef(loaded.library.id, resourceRef);
    if (sameRef) {
      return ok({ item: this.#itemView(sameRef), dedupe: { resource: true, item: true }, referenceCount: this.store.countResourceRefs(resourceRef) });
    }

    if (this.store.countItems(loaded.library.id) >= MAX_ITEMS) return fail("LIMIT_EXCEEDED", "items");
    const row = this.store.insertItem({
      id: itemId(), libraryId: loaded.library.id, kind: "asset",
      title: clampText(title || name, 160) || "未命名素材",
      group: clampText(group, 40) || "未分组",
      resourceRef, checksum, mime: resolvedMime, bytes: buffer.length,
      mediaKind: mimeKind(resolvedMime, name), tags: tagList(tags),
      sourceKey: requestedKey, coverRef: mimeKind(resolvedMime, name) === "image" ? resourceRef : null,
      createdBy: loaded.user.id, createdAt: this.#now(), updatedAt: this.#now(),
    });
    return ok({ item: this.#itemView(row), dedupe: { resource: reusedResource, item: false }, referenceCount: this.store.countResourceRefs(resourceRef) });
  }

  #decodeBytes({ dataUrl, base64, sourcePath }) {
    const match = typeof dataUrl === "string" ? /^data:([^;,]{1,120});base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl) : null;
    if (match) return ok({ buffer: Buffer.from(match[2], "base64"), mime: match[1] });
    if (typeof base64 === "string" && /^[A-Za-z0-9+/=]+$/.test(base64)) return ok({ buffer: Buffer.from(base64, "base64"), mime: null });
    if (typeof sourcePath === "string" && sourcePath && fs.existsSync(sourcePath) && fs.statSync(sourcePath).isFile()) return ok({ buffer: fs.readFileSync(sourcePath), mime: null });
    return fail("INVALID_INPUT", "bytes");
  }

  async #importManagedFile({ context, buffer, name, mime }) {
    const dir = typeof this.tempDir === "function" ? this.tempDir() : (this.tempDir || path.join(os.tmpdir(), "openarc-canvas-dxos"));
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
    const safe = String(name).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "canvas-asset";
    const file = path.join(dir, "dxos-asset-" + Date.now().toString(36) + "-" + safe);
    fs.writeFileSync(file, buffer);
    try {
      // 先按 checksum 复用（资源域保证内容对象唯一；这里显式复用可避免第二个 resource_registry 行）。
      const existing = this.store.resourceByChecksum(sha256(buffer), buffer.length);
      const appContext = { ...context, appId: "resource-library" };
      if (existing && existing.owner_user_id) {
        const actor = this.#actor(context);
        if (actor.ok && existing.owner_user_id === actor.user.id) return ok({ resourceRef: String(existing.resource_id), dedupe: true });
      }
      const imported = await this.resourceService.importManaged({
        context: appContext, sourcePath: file, name: safe,
        resourceType: resourceTypeOf(mime, name), mimeType: mime, scope: "PERSONAL",
      });
      if (!imported || !imported.ok) return imported && imported.error ? imported : fail("IMPORT_FAILED");
      const ref = imported.resource && (imported.resource.resourceId || imported.resource.resourceRef);
      if (!ref) return fail("IMPORT_FAILED", "no-ref");
      return ok({ resourceRef: String(ref).replace(/^resource:\/\//, "").replace(/^openarc-asset:/, ""), dedupe: false });
    } finally {
      try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
    }
  }

  // ---------------------------------------------------------------- 条目（含 prompt / workflow）

  /** 源 :144-244 的条目写入（asset 的字节导入走 importAssetItem，这里处理元数据与 prompt/workflow）。 */
  upsertItem({ context, libraryId: id, item = {} } = {}) {
    const loaded = this.#load(context, id, { needEdit: true });
    if (!loaded.ok) return loaded;
    const kind = ITEM_KINDS.includes(item.kind) ? item.kind : "prompt";
    if (kind === "asset") return fail("INVALID_INPUT", "use-importAssetItem");
    const requestedId = str(item.id, 120);
    const requestedKey = str(item.sourceKey, 500) || null;
    const previous = requestedId ? this.store.itemById(requestedId) : requestedKey ? this.store.itemBySourceKey(loaded.library.id, requestedKey) : null;
    if (previous && previous.library_id !== loaded.library.id) return fail("NOT_FOUND");
    const title = clampText(item.title || (previous && previous.title), 160) || "未命名资产";
    const prompt = clampText(item.prompt != null ? item.prompt : previous && previous.prompt, 80000);
    const tags = tagList(item.tags != null ? item.tags : previous ? JSON.parse(previous.tags_json || "[]") : []);
    const promptRole = kind === "prompt" && PROMPT_ROLES.includes(String(item.promptRole || (previous && previous.prompt_role) || "")) ? String(item.promptRole || previous.prompt_role) : null;
    // 源 :221-228：prompt 内容变化时保留最多 12 版历史。
    const changed = previous && (previous.title !== title || previous.prompt !== prompt);
    const versions = kind === "prompt" && changed
      ? [{ updatedAt: Number(previous.updated_at), title: previous.title, prompt: previous.prompt }, ...(previous.versions_json ? JSON.parse(previous.versions_json) : [])].slice(0, 12)
      : previous && previous.versions_json ? JSON.parse(previous.versions_json) : undefined;
    const payload = {
      kind, title, prompt,
      group: kind === "asset" ? clampText(item.group, 40) : null,
      model: kind === "prompt" ? clampText(item.model, 120) : null,
      category: kind === "prompt" ? clampText(item.category, 120) : null,
      source: kind === "prompt" ? clampText(item.source, 240) : null,
      sourceKey: kind === "prompt" ? requestedKey : null,
      tags, skillId: kind === "prompt" ? clampText(item.skillId, 160) : null,
      promptRole, mediaKind: kind === "prompt" ? (item.mediaKind === "video" ? "video" : "image") : null,
      workflow: kind === "workflow" ? item.workflow : undefined,
      versions,
    };
    if (!previous && this.store.countItems(loaded.library.id) >= MAX_ITEMS) return fail("LIMIT_EXCEEDED", "items");
    const row = previous
      ? this.store.updateItem(previous.id, payload)
      : this.store.insertItem({ id: requestedId || itemId(), libraryId: loaded.library.id, createdBy: loaded.user.id, createdAt: this.#now(), updatedAt: this.#now(), ...payload });
    return ok({ item: this.#itemView(row) });
  }

  listItems({ context, libraryId: id, kind = null, query = "" } = {}) {
    const loaded = this.#load(context, id);
    if (!loaded.ok) return loaded;
    const q = str(query, 120).trim().toLowerCase();
    let rows = this.store.itemsOfLibrary(loaded.library.id);
    if (kind && ITEM_KINDS.includes(kind)) rows = rows.filter((row) => row.kind === kind);
    if (q) rows = rows.filter((row) => (row.title + " " + (row.prompt || "")).toLowerCase().includes(q));
    return ok({ items: rows.map((row) => this.#itemView(row)) });
  }

  /** 引用：返回稳定 ResourceRef 与当前引用计数（源 :229-243 的 media 字段在本仓是 ResourceRef）。 */
  referenceItem({ context, libraryId: id, itemId: targetId } = {}) {
    const loaded = this.#load(context, id);
    if (!loaded.ok) return loaded;
    const row = this.store.itemById(targetId);
    if (!row || row.library_id !== loaded.library.id) return fail("NOT_FOUND");
    if (!row.resource_ref) return fail("INVALID_INPUT", "item-has-no-media");
    return ok({
      ref: "openarc-asset:" + row.resource_ref,
      resourceId: row.resource_ref,
      referenceCount: this.store.countResourceRefs(row.resource_ref),
      item: this.#itemView(row),
    });
  }

  /** 把素材挂到画布（复用既有 canvas:command 的 node.add，不新建画布命令层）。 */
  attachItemToCanvas({ context, libraryId: id, itemId: targetId, canvasId, x = 0, y = 0 } = {}) {
    const loaded = this.#load(context, id);
    if (!loaded.ok) return loaded;
    const row = this.store.itemById(targetId);
    if (!row || row.library_id !== loaded.library.id || !row.resource_ref) return fail("NOT_FOUND");
    if (!this.canvasService || typeof this.canvasService.applyCommand !== "function") return fail("CANVAS_UNAVAILABLE");
    const view = this.canvasService.getCanvas({ context, canvasId });
    if (!view || !view.ok) return view && view.error ? view : fail("NOT_FOUND");
    const type = row.media_kind === "video" ? "video" : row.media_kind === "image" ? "image" : "output";
    const applied = this.canvasService.applyCommand({
      context, canvasId, baseRevision: view.canvas.revision,
      command: { type: "node.add", node: { type, x: Number(x) || 0, y: Number(y) || 0, name: row.title, mediaKind: row.media_kind || "file", refs: ["openarc-asset:" + row.resource_ref] } },
      actorKind: "USER",
    });
    if (!applied.ok) return applied;
    const created = applied.result && applied.result.node ? applied.result.node : null;
    if (created) this.store.updateItem(row.id, { coverRef: row.cover_ref || row.resource_ref });
    return ok({ canvasId, nodeId: created ? created.id : null, revision: applied.canvas.revision, ref: "openarc-asset:" + row.resource_ref });
  }

  /** 源 :246-255：系统提示词不能删。 */
  deleteItem({ context, libraryId: id, itemId: targetId } = {}) {
    const loaded = this.#load(context, id, { needEdit: true });
    if (!loaded.ok) return loaded;
    const row = this.store.itemById(targetId);
    if (!row || row.library_id !== loaded.library.id) return fail("NOT_FOUND");
    if (row.prompt_role) return fail("INVALID_INPUT", "system-prompt-protected");
    this.store.deleteItem(row.id);
    return ok({ removed: row.id, referenceCount: row.resource_ref ? this.store.countResourceRefs(row.resource_ref) : 0 });
  }
}

module.exports = {
  CanvasAssetLibraryService, LIBRARY_FORMAT, DEFAULT_NAME, MAX_ITEMS, MAX_ASSET_BYTES,
  ITEM_KINDS, PROMPT_ROLES, CANVAS_SYSTEM_PROMPT_TEMPLATES, mimeKind, resourceTypeOf, tagList,
};
