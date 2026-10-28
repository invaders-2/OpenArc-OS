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
const ITEM_KINDS = Object.freeze(["asset", "prompt", "workflow", "character"]);
// task-25 A10：DX 的 visibility private|public|restricted + publicAccess read|edit + 逐成员 ACL。
// ORGANIZATION 保留为既有兼容档（同组织只读）。
const LIBRARY_VISIBILITIES = Object.freeze(["PRIVATE", "ORGANIZATION", "PUBLIC", "RESTRICTED"]);
const PUBLIC_ACCESS = Object.freeze(["READ", "EDIT"]);
const MEMBER_ROLES = Object.freeze(["read", "edit"]);
function normalizeVisibility(value, fallback = "PRIVATE") {
  const raw = String(value || "").trim().toUpperCase();
  return LIBRARY_VISIBILITIES.includes(raw) ? raw : fallback;
}
function normalizePublicAccess(value, fallback = "READ") {
  const raw = String(value || "").trim().toUpperCase();
  return PUBLIC_ACCESS.includes(raw) ? raw : fallback;
}
function normalizeMemberRole(value) {
  const raw = String(value || "").trim().toLowerCase();
  return MEMBER_ROLES.includes(raw) ? raw : null;
}
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
  constructor({ identity, store, resourceService = null, resourceStore = null, canvasService = null, fsStore = null, authorization = null, tempDir = null, clock = null, logger = null } = {}) {
    if (!identity || !store) throw new Error("CanvasAssetLibraryService 需要 identity 与 store");
    this.identity = identity;
    this.store = store;
    this.resourceService = resourceService;
    this.resourceStore = resourceStore;
    this.canvasService = canvasService;
    // DX 虚拟文件树（共享盘/部门盘/用户目录）与授权服务：同步导入"文件节点"时用；
    // 由宿主在装配后按需注入（createDxosFsAdapter 晚于画布域创建）。
    this.fsStore = fsStore;
    this.authorization = authorization;
    this.tempDir = tempDir;
    this.clock = typeof clock === "function" ? clock : () => Date.now();
    this.logger = logger;
    this.folderRegistryFile = process.env.OPENARC_ASSET_FOLDERS_FILE || path.join(os.homedir(), "Library", "Application Support", "openarc-os", "dxos", "asset-library-folders.json");
    this.customFolders = this.#readFolderRegistry();
  }

  #readFolderRegistry() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.folderRegistryFile, "utf8"));
      const map = new Map();
      for (const [libraryId, names] of Object.entries(parsed && typeof parsed === "object" ? parsed : {})) {
        if (Array.isArray(names)) map.set(libraryId, new Set(names.filter((name) => typeof name === "string" && name.trim()).map((name) => name.slice(0, 60))));
      }
      return map;
    } catch { return new Map(); }
  }

  #writeFolderRegistry() {
    try {
      fs.mkdirSync(path.dirname(this.folderRegistryFile), { recursive: true, mode: 0o700 });
      const out = {};
      for (const [libraryId, names] of this.customFolders) out[libraryId] = [...names];
      const temp = this.folderRegistryFile + ".tmp";
      fs.writeFileSync(temp, JSON.stringify(out), { mode: 0o600 });
      fs.renameSync(temp, this.folderRegistryFile);
    } catch (error) { try { this.logger?.("[asset-folders] persist failed " + String((error && error.message) || error)); } catch { /* ignore */ } }
  }

  /** 晚绑定 dxos-fs 实例（宿主在 createDxosFsAdapter 之后调用；未注入时文件节点同步结构化不可用）。 */
  configureFs(fsStore) {
    this.fsStore = fsStore && typeof fsStore.getNode === "function" ? fsStore : null;
    return { configured: !!this.fsStore };
  }

  // ---------------------------------------------------------------- 内部

  #actor(context) {
    const view = this.identity.validateSession(context && context.sessionRef, { sensitive: false });
    if (!view || !view.ok) return fail("NOT_FOUND_OR_FORBIDDEN");
    return ok({ user: view.user });
  }

  #now() { return Number(this.clock()); }

  /**
   * task-25 A10：owner / 逐成员 / publicAccess / 组织可见四层判定。
   * 非成员访问 restricted 返回 null（调用方回 NOT_FOUND_OR_FORBIDDEN，不泄露存在性）。
   */
  #access(library, user) {
    if (!library) return null;
    if (library.owner_user_id === user.id) return { level: "owner", canEdit: true, canView: true };
    const member = this.store && typeof this.store.memberOfLibrary === "function" ? this.store.memberOfLibrary(library.id, user.id) : null;
    if (member) {
      const role = normalizeMemberRole(member.role) || "read";
      return { level: role === "edit" ? "edit" : "read", canEdit: role === "edit", canView: true };
    }
    if (library.visibility === "PUBLIC") {
      const canEdit = normalizePublicAccess(library.public_access) === "EDIT";
      return { level: canEdit ? "edit" : "read", canEdit, canView: true };
    }
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
      publicAccess: normalizePublicAccess(library.public_access),
      version: Number(library.version || 1),
      access: access ? (access.level === "owner" ? "owner" : access.canEdit ? "edit" : "read") : "read",
      itemCount: this.store.countItems(library.id),
      updatedAt: Number(library.updated_at || 0),
      createdAt: Number(library.created_at || 0),
    };
  }

  #itemView(row, context = null) {
    const resourceRef = row.resource_ref || null;
    const readUrl = (ref) => {
      if (!ref || !context || !this.canvasService || typeof this.canvasService.readAsset !== "function") return null;
      const read = this.canvasService.readAsset({ context, ref: "openarc-asset:" + ref });
      return read && read.ok && read.dataUrl ? String(read.dataUrl) : null;
    };
    const url = readUrl(resourceRef);
    const previewUrl = readUrl(row.cover_ref) || url;
    return {
      id: row.id,
      libraryId: row.library_id,
      kind: row.kind,
      title: row.title,
      ...(row.group_name ? { group: row.group_name } : {}),
      // 源 shared/canvasAssetLibrary.ts:39-43 的关联字段（asset 条目"关联资产"语义，先 relationId 再展开）。
      ...(row.relation_id ? {
        relationId: row.relation_id,
        relationName: row.relation_name || "关联资产",
        ...(row.relation_role ? { relationRole: row.relation_role } : {}),
        ...(row.relation_primary ? { relationPrimary: true } : {}),
        ...(row.relation_prompt ? { relationPrompt: row.relation_prompt } : {}),
      } : {}),
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
      ...(url ? { url } : {}),
      ...(previewUrl ? { previewUrl } : {}),
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
    return ok({ library: this.#libraryView(library, access), items: seeded.items.map((row) => this.#itemView(row, context)) });
  }

  createLibrary({ context, name = DEFAULT_NAME, visibility = "PRIVATE", publicAccess = "READ" } = {}) {
    const actor = this.#actor(context);
    if (!actor.ok) return actor;
    const library = this.store.insertLibrary({
      id: libraryId(), organizationId: actor.user.team_id, ownerUserId: actor.user.id,
      name: String(name || DEFAULT_NAME).trim().slice(0, 120) || DEFAULT_NAME,
      format: LIBRARY_FORMAT,
      visibility: normalizeVisibility(visibility),
      publicAccess: normalizePublicAccess(publicAccess).toLowerCase(),
    });
    const seeded = this.#seedSystemPrompts(library, actor.user.id);
    return ok({ library: this.#libraryView(library, this.#access(library, actor.user)), items: seeded.items.map((row) => this.#itemView(row)) });
  }

  /**
   * 源 :51-75 / developerCollabProjects.updateDeveloperCollabProject 的库级更新：
   * 改名 / 可见性 + version+1，走基准版本检查（store.touchLibrary 的 changes=0 即冲突）。
   * 这就是 canvas-dxos-store.cjs touchLibrary 的唯一调用点。
   */
  updateLibrary({ context, libraryId: id, name = null, visibility = null, publicAccess = null, baseVersion = null } = {}) {
    const loaded = this.#load(context, id, { needEdit: true });
    if (!loaded.ok) return loaded;
    // 可见性 / publicAccess 是共享设置：edit 成员只能改名称与内容，不能自行放开共享范围。
    if ((visibility != null || publicAccess != null) && loaded.access.level !== "owner") return fail("FORBIDDEN", "只有所有者可以修改共享设置");
    const current = loaded.library;
    const base = Number.isFinite(Number(baseVersion)) ? Number(baseVersion) : Number(current.version || 1);
    if (base !== Number(current.version || 1)) return fail("REVISION_CONFLICT", { baseVersion: base, currentVersion: Number(current.version || 1) });
    const nextName = name == null ? current.name : (String(name).trim().slice(0, 120) || current.name);
    const nextVisibility = visibility == null ? current.visibility : normalizeVisibility(visibility, current.visibility);
    const nextPublicAccess = publicAccess == null ? normalizePublicAccess(current.public_access) : normalizePublicAccess(publicAccess);
    const updated = this.store.touchLibrary({ id: current.id, name: nextName, visibility: nextVisibility, publicAccess: nextPublicAccess.toLowerCase(), baseVersion: base });
    if (!updated) return fail("REVISION_CONFLICT", { baseVersion: base, currentVersion: Number(this.store.libraryById(current.id).version || 1) });
    return ok({ library: this.#libraryView(updated, this.#access(updated, loaded.user)) });
  }

  /** task-25 A10：逐成员 ACL（仅 owner 可改）。 */
  listMembers({ context, libraryId: id } = {}) {
    const loaded = this.#load(context, id);
    if (!loaded.ok) return loaded;
    if (loaded.access.level !== "owner") return fail("NOT_FOUND_OR_FORBIDDEN");
    return ok({ members: this.store.membersOfLibrary(loaded.library.id).map((row) => ({ userId: row.user_id, role: row.role, createdAt: Number(row.created_at || 0), updatedAt: Number(row.updated_at || 0) })) });
  }

  setMember({ context, libraryId: id, userId, role = "read" } = {}) {
    const loaded = this.#load(context, id);
    if (!loaded.ok) return loaded;
    if (loaded.access.level !== "owner") return fail("NOT_FOUND_OR_FORBIDDEN");
    const target = String(userId || "").trim();
    const normalizedRole = normalizeMemberRole(role);
    if (!target) return fail("INVALID_INPUT", "userId");
    if (!normalizedRole) return fail("INVALID_INPUT", "role 只支持 read / edit");
    if (target === loaded.library.owner_user_id) return fail("INVALID_INPUT", "owner 不需要成员授权");
    const row = this.store.upsertMember({ libraryId: loaded.library.id, userId: target, role: normalizedRole });
    return ok({ member: { userId: row.user_id, role: row.role } });
  }

  removeMember({ context, libraryId: id, userId } = {}) {
    const loaded = this.#load(context, id);
    if (!loaded.ok) return loaded;
    if (loaded.access.level !== "owner") return fail("NOT_FOUND_OR_FORBIDDEN");
    const target = String(userId || "").trim();
    if (!target) return fail("INVALID_INPUT", "userId");
    return ok({ removed: this.store.deleteMember({ libraryId: loaded.library.id, userId: target }) });
  }

  /** 源 :77-82：列举本人库 + 组织可见库 + 成员库；顺带补系统提示词。 */
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
      const access = this.#access(row, actor.user);
      if (!access) continue;
      seen.set(row.id, this.#libraryView(row, access));
    }
    for (const row of this.store.librariesByMember(actor.user.id)) {
      if (seen.has(row.id)) continue;
      const access = this.#access(row, actor.user);
      if (!access) continue;
      seen.set(row.id, this.#libraryView(row, access));
    }
    return ok({ libraries: [...seen.values()].sort((a, b) => b.updatedAt - a.updatedAt) });
  }

  getLibrary({ context, libraryId: id } = {}) {
    const loaded = this.#load(context, id);
    if (!loaded.ok) return loaded;
    this.#seedSystemPrompts(loaded.library, loaded.user.id);
    return ok({
      library: this.#libraryView(loaded.library, loaded.access),
      items: this.store.itemsOfLibrary(loaded.library.id).map((row) => this.#itemView(row, context)),
    });
  }

  // ---------------------------------------------------------------- 文件夹（复用 group_name）
  #folderNames(libraryId) {
    const names = new Set();
    for (const row of this.store.itemsOfLibrary(libraryId)) if (row.group_name && row.group_name !== "未分组") names.add(row.group_name);
    for (const name of this.customFolders.get(libraryId) || []) names.add(name);
    return [...names];
  }

  folderList({ context, libraryId: id } = {}) {
    const loaded = this.#load(context, id, { needEdit: false });
    if (!loaded.ok) return loaded;
    const counts = new Map();
    for (const row of this.store.itemsOfLibrary(loaded.library.id)) { const name = row.group_name || "未分组"; counts.set(name, (counts.get(name) || 0) + 1); }
    return ok({ folders: this.#folderNames(loaded.library.id).map((name) => ({ name, count: counts.get(name) || 0, custom: (this.customFolders.get(loaded.library.id) || new Set()).has(name) })) });
  }

  folderCreate({ context, libraryId: id, name } = {}) {
    const loaded = this.#load(context, id, { needEdit: true });
    if (!loaded.ok) return loaded;
    const folder = str(name, 60).trim();
    if (!folder || folder === "全部" || folder === "未分组") return fail("INVALID_INPUT", "folder-name");
    const names = this.#folderNames(loaded.library.id);
    if (names.includes(folder)) return fail("CONFLICT", "folder-exists");
    const set = this.customFolders.get(loaded.library.id) || new Set();
    set.add(folder); this.customFolders.set(loaded.library.id, set); this.#writeFolderRegistry();
    return ok({ folder: { name: folder, count: 0, custom: true } });
  }

  folderRename({ context, libraryId: id, from, to } = {}) {
    const loaded = this.#load(context, id, { needEdit: true });
    if (!loaded.ok) return loaded;
    const oldName = str(from, 60).trim(); const nextName = str(to, 60).trim();
    if (!oldName || !nextName || nextName === "全部" || nextName === "未分组") return fail("INVALID_INPUT", "folder-name");
    const names = this.#folderNames(loaded.library.id);
    if (!names.includes(oldName)) return fail("NOT_FOUND", "folder");
    if (oldName !== nextName && names.includes(nextName)) return fail("CONFLICT", "folder-exists");
    for (const row of this.store.itemsOfLibrary(loaded.library.id)) if ((row.group_name || "未分组") === oldName) this.store.updateItem(row.id, { group: nextName });
    const set = this.customFolders.get(loaded.library.id) || new Set();
    if (set.delete(oldName)) set.add(nextName);
    this.customFolders.set(loaded.library.id, set); this.#writeFolderRegistry();
    return ok({ from: oldName, to: nextName });
  }

  folderMove({ context, libraryId: id, itemId, folder } = {}) {
    const loaded = this.#load(context, id, { needEdit: true });
    if (!loaded.ok) return loaded;
    const row = this.store.itemById(str(itemId, 80));
    if (!row || row.library_id !== loaded.library.id) return fail("NOT_FOUND", "item");
    const target = str(folder, 60).trim() || "未分组";
    if (target !== "未分组" && !this.#folderNames(loaded.library.id).includes(target)) return fail("INVALID_INPUT", "folder-not-found");
    const updated = this.store.updateItem(row.id, { group: target });
    return ok({ item: this.#itemView(updated || row) });
  }

  // ---------------------------------------------------------------- AI 角色（条目 kind=character）
  #characterView(row) {
    let data = {};
    try { data = row.workflow_json ? JSON.parse(row.workflow_json) : {}; } catch { data = {}; }
    return {
      id: row.id,
      name: row.title || "",
      description: typeof data.description === "string" ? data.description : "",
      prompt: row.prompt || "",
      referenceUrls: Array.isArray(data.referenceUrls) ? data.referenceUrls : [],
      createdAt: Number(row.created_at || 0),
      updatedAt: Number(row.updated_at || 0),
    };
  }

  #characterData(input, current = {}) {
    const nameRaw = String(input && input.name !== undefined ? input.name : current.name || "").trim();
    if (!nameRaw || nameRaw.length > 80) return fail("INVALID_INPUT", "character-name");
    const name = nameRaw;
    const descriptionRaw = String(input && input.description !== undefined ? input.description : (current.description || ""));
    if (descriptionRaw.length > 500) return fail("INVALID_INPUT", "character-description");
    const description = descriptionRaw.trim();
    const promptRaw = String(input && input.prompt !== undefined ? input.prompt : (current.prompt || ""));
    if (promptRaw.length > 4000) return fail("INVALID_INPUT", "character-prompt");
    const prompt = promptRaw.trim();
    const urls = Array.isArray(input && input.referenceUrls) ? input.referenceUrls : (Array.isArray(current.referenceUrls) ? current.referenceUrls : []);
    const referenceUrls = [];
    for (const raw of urls.slice(0, 12)) {
      const url = str(raw, 2000).trim();
      if (!url) continue;
      if (!/^https?:\/\//i.test(url) && !url.startsWith("openarc-asset:")) return fail("INVALID_INPUT", "character-reference-url");
      referenceUrls.push(url);
    }
    return ok({ name, description, prompt, referenceUrls });
  }

  characterCreate({ context, libraryId: id, name, description = "", prompt = "", referenceUrls = [] } = {}) {
    const loaded = this.#load(context, id, { needEdit: true });
    if (!loaded.ok) return loaded;
    const normalized = this.#characterData({ name, description, prompt, referenceUrls });
    if (!normalized.ok) return normalized;
    const row = this.store.insertItem({
      id: itemId(), libraryId: loaded.library.id, kind: "character", title: normalized.name,
      prompt: normalized.prompt, group: "AI 角色", workflowJson: JSON.stringify({ description: normalized.description, referenceUrls: normalized.referenceUrls }),
      createdBy: loaded.user.id, createdAt: this.#now(), updatedAt: this.#now(),
    });
    return ok({ character: this.#characterView(row) });
  }

  characterList({ context, libraryId: id } = {}) {
    const loaded = this.#load(context, id, { needEdit: false });
    if (!loaded.ok) return loaded;
    return ok({ characters: this.store.itemsOfLibrary(loaded.library.id).filter((row) => row.kind === "character").map((row) => this.#characterView(row)) });
  }

  characterUpdate({ context, libraryId: id, itemId: targetId, name, description, prompt, referenceUrls } = {}) {
    const loaded = this.#load(context, id, { needEdit: true });
    if (!loaded.ok) return loaded;
    const row = this.store.itemById(str(targetId, 80));
    if (!row || row.library_id !== loaded.library.id || row.kind !== "character") return fail("NOT_FOUND", "character");
    const current = this.#characterView(row);
    const normalized = this.#characterData({ name, description, prompt, referenceUrls }, current);
    if (!normalized.ok) return normalized;
    const updated = this.store.updateItem(row.id, { title: normalized.name, prompt: normalized.prompt, workflowJson: JSON.stringify({ description: normalized.description, referenceUrls: normalized.referenceUrls }) });
    return ok({ character: this.#characterView(updated || row) });
  }

  characterDelete({ context, libraryId: id, itemId: targetId } = {}) {
    const loaded = this.#load(context, id, { needEdit: true });
    if (!loaded.ok) return loaded;
    const row = this.store.itemById(str(targetId, 80));
    if (!row || row.library_id !== loaded.library.id || row.kind !== "character") return fail("NOT_FOUND", "character");
    this.store.deleteItem(row.id);
    return ok({ removed: true });
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

  /**
   * 源 canvasAssetLibrary sync-sources（index.ts:5844-5875 的领域层实现）：
   * 从文件 / 画布节点同步素材进资产库。规则逐条对齐：
   *   · 只有资产库所有者可同步；
   *   · 单次最多 600 项，按 nodeId 去重；已存在 sourceKey=asset-source:<nodeId> 的条目跳过；
   *   · 资产库条目上限 1000；
   *   · 先对所有来源做权限判定（任一不可读即整体拒绝，不产生半写），再逐条建条目；
   *   · 字节只在资源域存一份，条目引用同一个 ResourceRef（同 checksum 复用 content object）。
   * 返回 { library, imported }；空来源如实返回 imported=0。
   */
  async syncSources({ context, libraryId: id, items = [] } = {}) {
    const loaded = this.#load(context, id, { needEdit: true });
    if (!loaded.ok) return loaded;
    if (loaded.access.level !== "owner") return fail("FORBIDDEN", "只有资产库所有者可以同步导入来源");
    if (!Array.isArray(items) || items.length > 600) return fail("INVALID_INPUT", "单次最多同步 600 项素材");
    const unique = new Map();
    for (const raw of items) {
      const entry = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
      const nodeId = str(entry.nodeId, 160).trim();
      if (!nodeId) continue;
      if (!unique.has(nodeId)) unique.set(nodeId, { nodeId, name: str(entry.name, 160).trim() || null, canvasId: str(entry.canvasId, 120).trim() || null });
    }
    const existing = new Set(this.store.itemsOfLibrary(loaded.library.id).map((row) => row.source_key).filter(Boolean));
    const additions = [...unique.values()].filter((entry) => !existing.has("asset-source:" + entry.nodeId));
    if (this.store.countItems(loaded.library.id) + additions.length > MAX_ITEMS) {
      return fail("LIMIT_EXCEEDED", "共享资产库容量不足，请减少导入来源素材后重试");
    }
    if (!additions.length) return ok({ library: this.#libraryView(loaded.library, loaded.access), imported: 0 });

    // 先全部解析并做权限判定：任一失败就整体拒绝，避免"一半已导入"。
    const resolved = [];
    for (const entry of additions) {
      const source = await this.#resolveSourceNode({ context, user: loaded.user, sourceNodeId: entry.nodeId });
      if (!source.ok) return source;
      resolved.push({ entry, source });
    }

    let imported = 0;
    let library = loaded.library;
    for (const { entry, source } of resolved) {
      const title = entry.name || source.name || "未命名素材";
      const written = await this.#upsertAssetItem({
        context,
        loaded: { ...loaded, library },
        item: { kind: "asset", title, group: "未分组", prompt: "", sourceNodeId: entry.nodeId, sourceKey: "asset-source:" + entry.nodeId },
        previous: null,
        requestedId: null,
        title,
        resolvedSource: source,
      });
      if (!written.ok) return written;
      imported += 1;
    }
    const fresh = this.store.libraryById(loaded.library.id);
    return ok({ library: this.#libraryView(fresh, this.#access(fresh, loaded.user)), imported });
  }

  /**
   * 源 :144-244 的条目写入：asset / prompt / workflow 三种 kind。
   * 为什么是 async：源用 fs copyNode / createNode 同步落文件；本仓素材字节统一走资源域的
   * resourceService.importManaged（异步），coverDataUrl 也必须先落成 ResourceRef，故整体改为 async。
   */
  async upsertItem({ context, libraryId: id, item = {} } = {}) {
    const loaded = this.#load(context, id, { needEdit: true });
    if (!loaded.ok) return loaded;
    const kind = ITEM_KINDS.includes(item.kind) ? item.kind : "prompt";
    const requestedId = str(item.id, 120);
    const requestedKey = str(item.sourceKey, 500) || null;
    const previous = requestedId ? this.store.itemById(requestedId) : requestedKey ? this.store.itemBySourceKey(loaded.library.id, requestedKey) : null;
    if (previous && previous.library_id !== loaded.library.id) return fail("NOT_FOUND");
    const title = clampText(item.title || (previous && previous.title), 160) || "未命名资产";
    if (kind === "asset") return this.#upsertAssetItem({ context, loaded, item, previous, requestedId, title });
    const prompt = clampText(item.prompt != null ? item.prompt : previous && previous.prompt, 80000);
    const tags = tagList(item.tags != null ? item.tags : previous ? JSON.parse(previous.tags_json || "[]") : []);
    const promptRole = kind === "prompt" && PROMPT_ROLES.includes(String(item.promptRole || (previous && previous.prompt_role) || "")) ? String(item.promptRole || previous.prompt_role) : null;
    // 源 :221-228：prompt 内容变化时保留最多 12 版历史。
    const changed = previous && (previous.title !== title || previous.prompt !== prompt);
    const versions = kind === "prompt" && changed
      ? [{ updatedAt: Number(previous.updated_at), title: previous.title, prompt: previous.prompt }, ...(previous.versions_json ? JSON.parse(previous.versions_json) : [])].slice(0, 12)
      : previous && previous.versions_json ? JSON.parse(previous.versions_json) : undefined;
    // 源 :212-216：coverDataUrl 对 prompt / workflow 同样生效；workflow 遇到非法封面按源静默忽略。
    let coverRef = previous ? previous.cover_ref : null;
    if (typeof item.coverDataUrl === "string" && item.coverDataUrl) {
      if (/^data:image\/(?:png|jpeg|webp);base64,/.test(item.coverDataUrl)) {
        const cover = await this.#importCover({ context, dataUrl: item.coverDataUrl, title });
        if (!cover.ok) return cover;
        coverRef = cover.resourceRef;
      } else if (kind !== "workflow") {
        return fail("INVALID_INPUT", "封面仅支持 PNG、JPEG 或 WebP");
      }
    }
    let workflow = kind === "workflow" ? item.workflow : undefined;
    if (kind === "workflow" && item.workflow != null) {
      const materialized = await this.#materializeWorkflowMedia({ context, user: loaded.user, workflow: item.workflow });
      if (!materialized.ok) return materialized;
      workflow = materialized.workflow;
    }
    const payload = {
      kind, title, prompt, coverRef,
      group: kind === "asset" ? clampText(item.group, 40) : null,
      model: kind === "prompt" ? clampText(item.model, 120) : null,
      category: kind === "prompt" ? clampText(item.category, 120) : null,
      source: kind === "prompt" ? clampText(item.source, 240) : null,
      sourceKey: kind === "prompt" ? requestedKey : null,
      tags, skillId: kind === "prompt" ? clampText(item.skillId, 160) : null,
      promptRole, mediaKind: kind === "prompt" ? (item.mediaKind === "video" ? "video" : "image") : null,
      workflow,
      versions,
    };
    if (!previous && this.store.countItems(loaded.library.id) >= MAX_ITEMS) return fail("LIMIT_EXCEEDED", "items");
    const row = previous
      ? this.store.updateItem(previous.id, payload)
      : this.store.insertItem({ id: requestedId || itemId(), libraryId: loaded.library.id, createdBy: loaded.user.id, createdAt: this.#now(), updatedAt: this.#now(), ...payload });
    return ok({ item: this.#itemView(row) });
  }

  /**
   * 源 :179-237 的 asset 分支：sourceNodeId 复制 + relation* + coverDataUrl 语义逐字补齐。
   * 本仓差异：字节仍在资源域（content-addressed），复制 = 复用同一 ResourceRef 后建库内条目，
   * 与 importAssetItem 的去重口径一致，不产生第二份内容对象。
   */
  async #upsertAssetItem({ context, loaded, item, previous, requestedId, title, resolvedSource = null }) {
    const hasRelationId = Object.prototype.hasOwnProperty.call(item, "relationId");
    const relationId = String(hasRelationId ? item.relationId ?? "" : (previous && previous.relation_id) ?? "").trim().slice(0, 160);
    const relationName = relationId ? (String(item.relationName ?? (previous && previous.relation_name) ?? "关联资产").trim().slice(0, 80) || "关联资产") : "";
    const relationRole = relationId ? String(item.relationRole ?? (previous && previous.relation_role) ?? "").trim().slice(0, 60) : "";
    const relationPrimary = relationId ? item.relationPrimary === true : false;
    const relationPrompt = relationId ? String(item.relationPrompt ?? (previous && previous.relation_prompt) ?? "").trim().slice(0, 80000) : "";
    const group = String(item.group ?? (previous && previous.group_name) ?? "未分组").trim().slice(0, 40) || "未分组";
    const prompt = clampText(item.prompt != null ? item.prompt : previous && previous.prompt, 80000);

    let resourceRef = previous ? previous.resource_ref : null;
    let checksum = previous ? previous.checksum : null;
    let mime = previous ? previous.mime : null;
    let bytes = previous ? previous.bytes : null;
    let mediaKind = previous ? previous.media_kind : null;
    const sourceNodeId = str(item.sourceNodeId, 160).trim();
    if (sourceNodeId) {
      const resolved = resolvedSource || await this.#resolveSourceNode({ context, user: loaded.user, sourceNodeId, canUseSource: item.canUseSource });
      if (!resolved.ok) return resolved;
      resourceRef = resolved.resourceRef;
      checksum = resolved.checksum;
      mime = resolved.mime;
      bytes = resolved.bytes;
      mediaKind = resolved.mediaKind;
    }

    // 源 :212-217：coverDataUrl 优先于"图片素材自动当封面"；换源后旧封面不再适用。
    let coverRef = sourceNodeId ? null : previous ? previous.cover_ref : null;
    if (typeof item.coverDataUrl === "string" && item.coverDataUrl) {
      const cover = await this.#importCover({ context, dataUrl: item.coverDataUrl, title });
      if (!cover.ok) return cover;
      coverRef = cover.resourceRef;
    } else if (!coverRef && resourceRef && mediaKind === "image") {
      coverRef = resourceRef;
    }

    const payload = {
      kind: "asset", title, prompt, group,
      relationId: relationId || null, relationName: relationName || null, relationRole: relationRole || null,
      relationPrimary, relationPrompt: relationPrompt || null,
      resourceRef, checksum, mime, bytes, mediaKind, coverRef,
      tags: [], model: null, category: null, source: null, sourceKey: str(item.sourceKey, 500) || (previous && previous.source_key) || null, skillId: null, promptRole: null,
    };
    if (!previous && this.store.countItems(loaded.library.id) >= MAX_ITEMS) return fail("LIMIT_EXCEEDED", "items");
    const row = previous
      ? this.store.updateItem(previous.id, payload)
      : this.store.insertItem({ id: requestedId || itemId(), libraryId: loaded.library.id, createdBy: loaded.user.id, createdAt: this.#now(), updatedAt: this.#now(), ...payload });
    return ok({ item: this.#itemView(row) });
  }

  /**
   * 源 :206-211 的 sourceNodeId 分支：源用全局 fs getNode + copyNode。
   * 本仓两类节点都支持：
   *   · 画布节点：在该用户**可见**的画布里查节点并取其 ResourceRef（getCanvas 已强制访问判定）；
   *   · DX 虚拟文件树节点（共享盘 / 部门盘 / 个人目录）：先做 fs 可见性判定，再把字节导入资源域，
   *     条目只引用 ResourceRef（与 importAssetItem 的去重口径一致）。
   * 显式传入 canUseSource 时以其结论为准（与源 :208 一致，返回非 true 即拒绝）。
   */
  async #resolveSourceNode({ context, user, sourceNodeId, canUseSource = null }) {
    if (typeof canUseSource === "function" && canUseSource(sourceNodeId) !== true) return fail("FORBIDDEN", "没有源文件读取权限");
    // 1) 画布节点（含跨画布可见性判定）。
    if (this.canvasService && typeof this.canvasService.listCanvases === "function" && typeof this.canvasService.getCanvas === "function") {
      const listed = this.canvasService.listCanvases({ context });
      if (listed && listed.ok) {
        for (const entry of listed.items || []) {
          const view = this.canvasService.getCanvas({ context, canvasId: entry.canvasId });
          if (!view || !view.ok) continue;
          const node = (view.canvas.doc.nodes || []).find((candidate) => candidate.id === sourceNodeId);
          if (!node) continue;
          const ref = Array.isArray(node.refs) ? node.refs.find((value) => typeof value === "string" && value.startsWith("openarc-asset:"))
            : (typeof node.url === "string" && node.url.startsWith("openarc-asset:") ? node.url : null);
          if (!ref) return fail("INVALID_INPUT", "source-node-has-no-media");
          const resourceRef = ref.replace(/^openarc-asset:/, "");
          const resourceRow = this.resourceStore && typeof this.resourceStore.resourceRowById === "function" ? this.resourceStore.resourceRowById(resourceRef) : null;
          if (!resourceRow) return fail("NOT_FOUND", "source-resource");
          return ok({
            resourceRef,
            name: node.name || null,
            checksum: resourceRow.checksum || null,
            mime: resourceRow.mime_type || null,
            bytes: resourceRow.size == null ? null : Number(resourceRow.size),
            mediaKind: mimeKind(resourceRow.mime_type, resourceRow.name),
          });
        }
      }
    }
    // 2) DX 虚拟文件树节点（共享盘 / 部门盘 / 个人目录）。
    const port = this.fsStore;
    if (port && typeof port.getNode === "function" && typeof port.readBlob === "function") {
      const node = port.getNode(sourceNodeId);
      if (!node) return fail("NOT_FOUND", "source-node");
      const trashed = typeof port.isInTrash === "function" ? !!port.isInTrash(sourceNodeId) : node.trashed === true;
      if (trashed) return fail("NOT_FOUND", "source-node-trashed");
      if (!this.#canReadFsNode(node, context, user)) return fail("FORBIDDEN", "没有源文件读取权限");
      const buffer = port.readBlob(sourceNodeId);
      if (!buffer || !buffer.length) return fail("NOT_FOUND", "source-blob");
      const mime = typeof node.mime === "string" && node.mime ? node.mime : "application/octet-stream";
      const imported = await this.#importManagedFile({ context, buffer, name: node.name || "source", mime });
      if (!imported.ok) return imported;
      const resourceRow = this.resourceStore && typeof this.resourceStore.resourceRowById === "function" ? this.resourceStore.resourceRowById(imported.resourceRef) : null;
      return ok({
        resourceRef: imported.resourceRef,
        name: node.name || null,
        checksum: (resourceRow && resourceRow.checksum) || null,
        mime,
        bytes: buffer.length,
        mediaKind: mimeKind(mime, node.name),
      });
    }
    return fail("NOT_FOUND", "source-node");
  }

  /**
   * DX 虚拟文件树可见性：自己的文件 / public 共享盘 / 本部门（含超管）的部门盘。
   * canvas:* 与 asset-library:* 标记属于画布/素材库文件夹共享，不在这里当全局共享盘放行。
   */
  #canReadFsNode(node, context, user) {
    if (!node || !user) return false;
    if (node.ownerId && String(node.ownerId) === String(user.id)) return true;
    let share = typeof node.share === "string" ? node.share : null;
    if (!share && this.fsStore && typeof this.fsStore.shareZoneOf === "function") {
      try { share = this.fsStore.shareZoneOf(node.id) || null; } catch { share = null; }
    }
    if (!share) return false;
    if (share === "public") return true;
    if (!share.startsWith("department:")) return false;
    const departmentId = share.slice("department:".length);
    let isSuper = user.role === "ADMIN";
    let departmentIds = [];
    if (this.authorization && typeof this.authorization.resolveActor === "function") {
      try {
        const actor = this.authorization.resolveActor({ context });
        if (actor && actor.ok) {
          isSuper = isSuper || actor.isSuper === true;
          departmentIds = Array.isArray(actor.departmentIds) ? actor.departmentIds.map(String) : [];
        }
      } catch { /* 授权服务失败按拒绝处理 */ }
    }
    return isSuper || departmentIds.includes(departmentId);
  }

  /** 源 :102-111 materializeDataUrl 的等价：封面也进资源域，条目只存 ResourceRef。 */
  async #importCover({ context, dataUrl, title }) {
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([a-zA-Z0-9+/=]+)$/.exec(dataUrl);
    if (!match) return fail("INVALID_INPUT", "封面仅支持 PNG、JPEG 或 WebP");
    const buffer = Buffer.from(match[2], "base64");
    if (!buffer.length || buffer.length > 10 * 1024 * 1024) return fail("LIMIT_EXCEEDED", "封面文件不能为空且不能超过 10 MB");
    const extension = match[1] === "image/png" ? "png" : match[1] === "image/webp" ? "webp" : "jpg";
    const imported = await this.#importManagedFile({ context, buffer, name: (title || "模板封面") + "." + extension, mime: match[1] });
    if (!imported.ok) return imported;
    return ok({ resourceRef: imported.resourceRef });
  }

  /**
   * task-25 A07：workflow 内媒体递归复制（源 canvasAssetLibrary.ts:113-143 materializeWorkflowMedia）。
   * data: 媒体 / 已有 ResourceRef / nodeId 三类递归处理；任一无权限整单拒绝；返回新对象不改入参。
   */
  async #materializeWorkflowMedia({ context, user, workflow }) {
    let source;
    try { source = JSON.parse(JSON.stringify(workflow)); }
    catch { return fail("INVALID_INPUT", "workflow-not-json"); }
    if (!source || typeof source !== "object") return fail("INVALID_INPUT", "workflow-not-object");
    let mediaCount = 0;
    const refCache = new Map();
    const importDataUrl = async (dataUrl, name) => {
      const match = /^data:((?:image|audio|video)\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
      if (!match) return fail("INVALID_INPUT", "workflow-media-data-url");
      const buffer = Buffer.from(match[2], "base64");
      if (!buffer.length || buffer.length > 12 * 1024 * 1024) return fail("LIMIT_EXCEEDED", "workflow-media-too-large");
      const ext = match[1] === "image/png" ? "png" : match[1] === "image/webp" ? "webp" : match[1] === "image/jpeg" ? "jpg" : match[1].startsWith("audio/") ? "m4a" : "mp4";
      const imported = await this.#importManagedFile({ context, buffer, name: (name || "workflow-media") + "." + ext, mime: match[1] });
      return imported.ok ? ok({ ref: "openarc-asset:" + imported.resourceRef }) : imported;
    };
    const importRef = async (ref) => {
      if (refCache.has(ref)) return refCache.get(ref);
      const resourceId = String(ref).replace(/^(?:openarc-asset:|resource:\/\/)/, "");
      if (!this.resourceService || typeof this.resourceService.readDataUrl !== "function") return fail("RESOURCE_UNAVAILABLE");
      const data = this.resourceService.readDataUrl({ context: { ...context, appId: "resource-library" }, resourceRef: resourceId });
      if (!data || !data.ok) return fail("FORBIDDEN", "workflow-media-forbidden");
      const imported = await importDataUrl(data.dataUrl, "workflow-media");
      if (!imported || !imported.ok) return imported || fail("IMPORT_FAILED");
      refCache.set(ref, imported);
      return imported;
    };
    const rewriteUrlFields = (object, ref) => {
      for (const key of ["url", "src", "image", "imageUrl", "video", "audio", "path"]) {
        if (typeof object[key] === "string" && /^(?:data:|openarc-asset:|resource:\/\/)/.test(object[key])) object[key] = ref;
      }
      object.resourceRef = ref;
    };
    const walk = async (node, seen) => {
      if (node == null) return ok();
      if (typeof node === "string") {
        if (/^data:/.test(node)) {
          mediaCount += 1;
          if (mediaCount > 32) return fail("LIMIT_EXCEEDED", "workflow-media-count");
          const imported = await importDataUrl(node, "workflow-media");
          return imported;
        }
        if (/^(?:openarc-asset:|resource:\/\/)/.test(node)) {
          mediaCount += 1;
          if (mediaCount > 32) return fail("LIMIT_EXCEEDED", "workflow-media-count");
          return importRef(node);
        }
        return ok();
      }
      if (typeof node !== "object") return ok();
      if (seen.has(node)) return fail("INVALID_INPUT", "workflow-circular");
      seen.add(node);
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i += 1) {
          const item = node[i];
          if (typeof item === "string" && /^data:/.test(item)) {
            mediaCount += 1;
            if (mediaCount > 32) return fail("LIMIT_EXCEEDED", "workflow-media-count");
            const imported = await importDataUrl(item, "workflow-media");
            if (!imported.ok) return imported;
            node[i] = imported.ref;
            continue;
          }
          if (typeof item === "string" && /^(?:openarc-asset:|resource:\/\/)/.test(item)) {
            mediaCount += 1;
            if (mediaCount > 32) return fail("LIMIT_EXCEEDED", "workflow-media-count");
            const imported = await importRef(item);
            if (!imported.ok) return imported;
            node[i] = imported.ref;
            continue;
          }
          const nested = await walk(item, seen);
          if (!nested.ok) return nested;
        }
        seen.delete(node);
        return ok();
      }
      const nodeId = typeof node.nodeId === "string" ? node.nodeId : typeof node.sourceNodeId === "string" ? node.sourceNodeId : "";
      if (nodeId && !/^(?:data:|openarc-asset:|resource:\/\/)/.test(nodeId)) {
        mediaCount += 1;
        if (mediaCount > 32) return fail("LIMIT_EXCEEDED", "workflow-media-count");
        const resolved = await this.#resolveSourceNode({ context, user, sourceNodeId: nodeId });
        if (!resolved.ok) return resolved;
        rewriteUrlFields(node, "openarc-asset:" + resolved.resourceRef);
      }
      for (const [key, value] of Object.entries(node)) {
        if (key === "resourceRef" || key === "nodeId" || key === "sourceNodeId") continue;
        if (typeof value === "string" && /^data:/.test(value)) {
          mediaCount += 1;
          if (mediaCount > 32) return fail("LIMIT_EXCEEDED", "workflow-media-count");
          const imported = await importDataUrl(value, "workflow-media");
          if (!imported.ok) return imported;
          node[key] = imported.ref;
          continue;
        }
        if (typeof value === "string" && /^(?:openarc-asset:|resource:\/\/)/.test(value)) {
          mediaCount += 1;
          if (mediaCount > 32) return fail("LIMIT_EXCEEDED", "workflow-media-count");
          const imported = await importRef(value);
          if (!imported.ok) return imported;
          node[key] = imported.ref;
          continue;
        }
        const nested = await walk(value, seen);
        if (!nested.ok) return nested;
      }
      seen.delete(node);
      return ok();
    };
    const walked = await walk(source, new Set());
    if (!walked.ok) return walked;
    return ok({ workflow: source, mediaCount });
  }

  listItems({ context, libraryId: id, kind = null, query = "" } = {}) {
    const loaded = this.#load(context, id);
    if (!loaded.ok) return loaded;
    const q = str(query, 120).trim().toLowerCase();
    let rows = this.store.itemsOfLibrary(loaded.library.id);
    if (kind && ITEM_KINDS.includes(kind)) rows = rows.filter((row) => row.kind === kind);
    if (q) rows = rows.filter((row) => (row.title + " " + (row.prompt || "")).toLowerCase().includes(q));
    return ok({ items: rows.map((row) => this.#itemView(row, context)) });
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
