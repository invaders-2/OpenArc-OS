/**
 * B7b · 开发者协同项目（源 server/developerCollabProjects.ts:1-235）。
 *
 * ## 落到既有 ACL，不建第二套
 *   源自建 developer_collab_projects / developer_collab_members / developer_collab_invites 三张表；
 *   本仓硬约束禁止新增表结构，且 identity-store.cjs:687-717 明确 projects / project_members 就是
 *   项目与成员的唯一事实源。因此这里：
 *     · 协同项目       -> 既有 projects 行（scope='PERSONAL'，owner_user_id 即源 owner_id）；
 *     · 成员与角色     -> 既有 project_members 行（源 access 'read'/'edit' 映射为 'viewer'/'editor'）；
 *     · 项目附加元数据 -> projects.description 里的 JSON 前置块（含 appId/kind/visibility/publicAccess/
 *                         document/version）—— 不新增列，形状与 agent-task-store.cjs:15-26 的
 *                         "没有列就用桥接/承载语义"同一思路，且**只由本模块读写**；
 *     · 邀请口令       -> 仅进程内（哈希存储）；不落盘、不入库、不联网。
 *   最终资源访问仍逐资源走 D3-02 Authorization，本模块只决定"谁能改这个协同项目"。
 *
 * ## 与 integration-store.cjs 的写法对齐
 *   · 全部读写走 store 的既有方法（insertProject / projectById / membersOfProject / upsertMember /
 *     memberByPair / removeMember / updateProject），SQL 保持只在 integration-store.cjs 里；
 *   · 原子替换成员走 store.transactSync（integration-store.cjs:56）。
 *
 * OUT：云端实时房间 / 云端市场 / api.dx-os.com 一律不引入；本文件零网络。
 */
"use strict";

const crypto = require("node:crypto");

const CHANNEL = "developer:command";
const EVENT_CHANNEL = "developer:event";

const COLLAB_META_PREFIX = "dx-collab/v1 ";
const MAX_NAME_CHARS = 100;
const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const MAX_MEMBERS = 100;

// 源 :4 DeveloperCollabAccess + :164-171 的 access 语义
const COLLAB_ACCESS = Object.freeze({ READ: "read", EDIT: "edit", OWNER: "owner" });

const ok = (extra = {}) => ({ ok: true, ...extra });
const fail = (error, detail = null) => ({ ok: false, error: String(error), detail });
const asStr = (value, max = 200) => (value == null ? "" : String(value).slice(0, max));

function cleanName(value) { return asStr(value, MAX_NAME_CHARS).trim() || "未命名项目"; }

// 源 :65-68 cleanKind
function cleanKind(value) {
  const kind = asStr(value, 60).trim().toLowerCase() || "project";
  return /^[a-z][a-z0-9-]{0,48}$/.test(kind) ? kind : "project";
}

// 源 :69-73 cleanDocument（2 MB 上限）
function cleanDocument(value) {
  const json = JSON.stringify(value === undefined ? {} : value);
  if (Buffer.byteLength(json, "utf8") > MAX_DOCUMENT_BYTES) throw new Error("协同项目文档不能超过 2 MB");
  return JSON.parse(json);
}

// 源 :87-91 accessFor 的 OpenArc 落点：owner 看 owner_user_id，成员看 project_members.role。
function accessFor(project, userId, store) {
  if (project.owner_user_id === userId) return COLLAB_ACCESS.OWNER;
  const member = store.memberByPair(project.id, userId);
  if (member) return member.role === "viewer" ? COLLAB_ACCESS.READ : COLLAB_ACCESS.EDIT;
  const meta = decodeMeta(project);
  if (meta.visibility === "public") return meta.publicAccess === "edit" ? COLLAB_ACCESS.EDIT : COLLAB_ACCESS.READ;
  return null;
}

// 源 access 'read'/'edit' -> OpenArc role；反向把 manager 视作 editor（不制造第二个 owner）。
function accessToRole(access) { return access === "edit" ? "editor" : "viewer"; }
function roleToAccess(role) { return role === "viewer" ? COLLAB_ACCESS.READ : COLLAB_ACCESS.EDIT; }

function decodeMeta(project) {
  const raw = project && typeof project.description === "string" ? project.description : "";
  if (!raw.startsWith(COLLAB_META_PREFIX)) return { appId: null, kind: "project", visibility: "private", publicAccess: "read", document: {}, version: 1 };
  try {
    const parsed = JSON.parse(raw.slice(COLLAB_META_PREFIX.length));
    return {
      appId: parsed.appId ? String(parsed.appId) : null,
      kind: parsed.kind ? String(parsed.kind) : "project",
      visibility: ["private", "public", "restricted"].includes(parsed.visibility) ? parsed.visibility : "private",
      publicAccess: parsed.publicAccess === "edit" ? "edit" : "read",
      document: parsed.document === undefined ? {} : parsed.document,
      version: Number.isSafeInteger(Number(parsed.version)) && Number(parsed.version) > 0 ? Number(parsed.version) : 1,
    };
  } catch { return { appId: null, kind: "project", visibility: "private", publicAccess: "read", document: {}, version: 1 }; }
}

function encodeMeta(meta) { return COLLAB_META_PREFIX + JSON.stringify(meta); }

// 成员集合的稳定指纹：用作"变更集基线版本"，冲突时明确拒绝而不是覆盖别人。
function memberRevision(store, projectId) {
  const pairs = store.membersOfProject(projectId).map((row) => [row.user_id, row.role]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return crypto.createHash("sha256").update(JSON.stringify(pairs)).digest("hex").slice(0, 24);
}

class DeveloperCollabProjects {
  constructor({ identity = null, store, authService = null, clock = () => Date.now() } = {}) {
    if (!store) throw new Error("DeveloperCollabProjects 需要 integrationStore");
    if (!identity && !authService) throw new Error("DeveloperCollabProjects 需要 identity 或 authService");
    this.identity = identity;
    this.store = store;
    this.authService = authService;
    this.clock = typeof clock === "function" ? clock : () => Date.now();
    /** @type {Map<string, {id:string, codeHash:string, codeHint:string, access:string, createdAt:number, revokedAt:number|null}>} */
    this.invites = new Map();
  }

  #transact(fn) {
    if (this.store && typeof this.store.transactSync === "function") return this.store.transactSync(fn);
    if (this.store && typeof this.store.transact === "function") return this.store.transact(fn);
    return fn();
  }

  // 源 :1-2 的会话 → 用户；有 AuthorizationService 走 resolveActor（D3-04D 复用），否则身份库直查。
  #actor(context) {
    if (this.authService && typeof this.authService.resolveActor === "function") {
      const actor = this.authService.resolveActor({ context: context || {} });
      if (actor && actor.ok) return actor;
      return { ok: false, error: (actor && actor.error) || "UNAUTHORIZED" };
    }
    const session = this.identity && typeof this.identity.validateSession === "function"
      ? this.identity.validateSession(context && context.sessionRef, { sensitive: false }) : null;
    if (!session || !session.ok) return { ok: false, error: "UNAUTHORIZED" };
    return { ok: true, user: session.user, organizationId: session.user.team_id };
  }

  #project(projectId) { return this.store.projectById(asStr(projectId, 120)) || null; }

  // 源 :92-100 requireProject：不存在 / 非本 App / 无权一律结构化拒绝。
  #requireProject(projectId, userId, required = "read") {
    const project = this.#project(projectId);
    if (!project) return { ok: false, error: "NOT_FOUND" };
    // 归档项目对外一律 NOT_FOUND_OR_FORBIDDEN（与 listProjects 只列 active 同口径，不泄漏存在性）。
    if (project.status !== "active") return { ok: false, error: "NOT_FOUND_OR_FORBIDDEN" };
    const access = accessFor(project, userId, this.store);
    if (!access) return { ok: false, error: "NOT_FOUND_OR_FORBIDDEN" };
    if (required === "owner" && access !== "owner") return { ok: false, error: "FORBIDDEN", detail: "owner-only" };
    if (required === "edit" && access === "read") return { ok: false, error: "FORBIDDEN", detail: "read-only" };
    return { ok: true, project, access };
  }

  // 源 :101-120 publicProject 的等价投影（成员 access 由 role 反推）
  publicProject(project, userId, includeDocument = false) {
    const meta = decodeMeta(project);
    const access = accessFor(project, userId, this.store);
    const invite = access === "owner" ? this.invites.get(project.id) : null;
    return {
      id: project.id, appId: meta.appId, ownerId: project.owner_user_id, name: project.name, kind: meta.kind,
      visibility: meta.visibility, publicAccess: meta.publicAccess, version: meta.version, access,
      members: this.store.membersOfProject(project.id).map((row) => ({ userId: row.user_id, access: roleToAccess(row.role) })),
      revision: memberRevision(this.store, project.id),
      ...(invite && !invite.revokedAt ? { invite: { id: invite.id, codeHint: invite.codeHint, access: invite.access, createdAt: invite.createdAt } } : {}),
      ...(includeDocument ? { document: meta.document } : {}),
      createdAt: project.created_at, updatedAt: project.updated_at,
    };
  }

  // 源 :122-128 createDeveloperCollabProject
  createProject({ context, name, kind, document, appId = null } = {}) {
    const actor = this.#actor(context);
    if (!actor.ok) return actor;
    let meta;
    try { meta = { appId: appId ? String(appId) : null, kind: cleanKind(kind), visibility: "private", publicAccess: "read", document: cleanDocument(document), version: 1 }; }
    catch (error) { return fail(String((error && error.message) || error)); }
    const project = this.#transact(() => this.store.insertProject({
      organizationId: actor.organizationId, ownerUserId: actor.user.id, name: cleanName(name),
      description: encodeMeta(meta), scope: "PERSONAL",
    }));
    return ok({ project: this.publicProject(project, actor.user.id, true) });
  }

  // 源 :130-135 listDeveloperCollabProjects（owner / member / public 三类可见）
  listProjects({ context, appId = null } = {}) {
    const actor = this.#actor(context);
    if (!actor.ok) return { ...actor, items: [] };
    const seen = new Map();
    for (const project of [...this.store.projectsOfMember(actor.user.id), ...this.store.projectsOwnedBy(actor.user.id)]) seen.set(project.id, project);
    // public 项目通过"组织内 active 项目"枚举后再过滤（projectsOfOrg 是既有方法，不新增 SQL）。
    for (const project of this.store.projectsOfOrg(actor.organizationId)) {
      const meta = decodeMeta(project);
      if (meta.visibility === "public" && (!appId || meta.appId === appId)) seen.set(project.id, project);
    }
    const items = [...seen.values()]
      .filter((project) => project.status === "active")
      .filter((project) => !appId || decodeMeta(project).appId === appId)
      .map((project) => this.publicProject(project, actor.user.id, false))
      .sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1));
    return ok({ items });
  }

  // 源 :137-140 getDeveloperCollabProject
  getProject({ context, projectId } = {}) {
    const actor = this.#actor(context);
    if (!actor.ok) return actor;
    const gate = this.#requireProject(projectId, actor.user.id, "read");
    if (!gate.ok) return gate;
    return ok({ project: this.publicProject(gate.project, actor.user.id, true) });
  }

  // 源 :142-159 updateDeveloperCollabProject：baseVersion 不符即 VERSION_CONFLICT，不写。
  updateProject({ context, projectId, baseVersion, name, kind, document } = {}) {
    const actor = this.#actor(context);
    if (!actor.ok) return actor;
    const gate = this.#requireProject(projectId, actor.user.id, "edit");
    if (!gate.ok) return gate;
    const meta = decodeMeta(gate.project);
    const base = Number(baseVersion);
    if (!Number.isSafeInteger(base) || base !== meta.version) {
      return fail("VERSION_CONFLICT", { baseVersion: base, currentVersion: meta.version });
    }
    let next;
    try {
      next = {
        ...meta,
        kind: kind === undefined ? meta.kind : cleanKind(kind),
        document: document === undefined ? meta.document : cleanDocument(document),
        version: meta.version + 1,
      };
    } catch (error) { return fail(String((error && error.message) || error)); }
    const project = this.#transact(() => this.store.updateProject(gate.project.id, {
      name: name === undefined ? gate.project.name : cleanName(name),
      description: encodeMeta(next),
    }));
    return ok({ project: this.publicProject(project, actor.user.id, true) });
  }

  // 源 :161-178 setDeveloperCollabMembers：owner-only，整表原子替换，非法目标整体拒绝（不半应用）
  setMembers({ context, projectId, members } = {}) {
    const actor = this.#actor(context);
    if (!actor.ok) return actor;
    const gate = this.#requireProject(projectId, actor.user.id, "owner");
    if (!gate.ok) return gate;
    const prepared = this.#prepareMembers(gate.project, actor.organizationId, members);
    if (!prepared.ok) return prepared;
    this.#transact(() => {
      const existing = this.store.membersOfProject(gate.project.id);
      for (const row of existing) this.store.removeMember(gate.project.id, row.user_id);
      for (const [userId, role] of prepared.entries) this.store.upsertMember(gate.project.id, userId, role);
    });
    return ok({ project: this.publicProject(this.#project(gate.project.id), actor.user.id, true) });
  }

  // 成员变更集：baseRevision 不符即 MEMBER_SET_CONFLICT；全部校验通过才在一个事务里落盘。
  applyMemberChangeset({ context, projectId, baseRevision = null, changes } = {}) {
    const actor = this.#actor(context);
    if (!actor.ok) return actor;
    const gate = this.#requireProject(projectId, actor.user.id, "owner");
    if (!gate.ok) return gate;
    const current = memberRevision(this.store, gate.project.id);
    if (baseRevision != null && String(baseRevision) !== current) {
      return fail("MEMBER_SET_CONFLICT", { baseRevision: String(baseRevision), currentRevision: current });
    }
    const list = Array.isArray(changes) ? changes.slice(0, MAX_MEMBERS) : [];
    if (!list.length && !Array.isArray(changes)) return fail("INVALID_INPUT", "changes");
    const planned = [];
    for (const item of list) {
      if (!item || typeof item !== "object") return fail("INVALID_INPUT", "changes-entry");
      const userId = asStr(item.userId, 120);
      const invalid = this.#validateMemberTarget(gate.project, actor.organizationId, userId);
      if (invalid) return invalid;
      planned.push({ userId, remove: item.remove === true || item.access === null, access: item.access });
    }
    this.#transact(() => {
      for (const change of planned) {
        if (change.remove) this.store.removeMember(gate.project.id, change.userId);
        else this.store.upsertMember(gate.project.id, change.userId, accessToRole(change.access));
      }
    });
    const project = this.#project(gate.project.id);
    return ok({ project: this.publicProject(project, actor.user.id, true), revision: memberRevision(this.store, gate.project.id) });
  }

  // 源 :180-186 setDeveloperCollabSharing：visibility 非 restricted 时成员集清空（访问走 public）
  setSharing({ context, projectId, visibility, publicAccess, members } = {}) {
    const actor = this.#actor(context);
    if (!actor.ok) return actor;
    const gate = this.#requireProject(projectId, actor.user.id, "owner");
    if (!gate.ok) return gate;
    const next = visibility === "public" ? "public" : visibility === "restricted" ? "restricted" : "private";
    const meta = { ...decodeMeta(gate.project), visibility: next, publicAccess: publicAccess === "edit" ? "edit" : "read" };
    const targetMembers = next === "restricted" ? members : [];
    const prepared = this.#prepareMembers(gate.project, actor.organizationId, targetMembers);
    if (!prepared.ok) return prepared;
    this.#transact(() => {
      this.store.updateProject(gate.project.id, { description: encodeMeta(meta) });
      const existing = this.store.membersOfProject(gate.project.id);
      for (const row of existing) this.store.removeMember(gate.project.id, row.user_id);
      for (const [userId, role] of prepared.entries) this.store.upsertMember(gate.project.id, userId, role);
    });
    return ok({ project: this.publicProject(this.#project(gate.project.id), actor.user.id, true) });
  }

  // ---- 邀请（源 :188-224）：仅进程内哈希存储；redeem 落 project_members ----
  createInvite({ context, projectId, access } = {}) {
    const actor = this.#actor(context);
    if (!actor.ok) return actor;
    const gate = this.#requireProject(projectId, actor.user.id, "owner");
    if (!gate.ok) return gate;
    const code = "DXP-" + crypto.randomBytes(5).toString("hex").toUpperCase();
    const invite = {
      id: crypto.randomUUID(),
      codeHash: this.#inviteHash(code),
      codeHint: code.slice(-5),
      access: access === "edit" ? "edit" : "read",
      createdAt: this.clock(),
      revokedAt: null,
    };
    this.invites.set(gate.project.id, invite);
    return ok({ code, invite: { id: invite.id, codeHint: invite.codeHint, access: invite.access, createdAt: invite.createdAt } });
  }

  revokeInvite({ context, projectId } = {}) {
    const actor = this.#actor(context);
    if (!actor.ok) return actor;
    const gate = this.#requireProject(projectId, actor.user.id, "owner");
    if (!gate.ok) return gate;
    const invite = this.invites.get(gate.project.id);
    if (invite) invite.revokedAt = this.clock();
    return ok({ revoked: true, projectId: gate.project.id });
  }

  // 源 :214-224 redeemDeveloperCollabInvite：口令有效即把用户写进 project_members
  redeemInvite({ context, projectId, code } = {}) {
    const actor = this.#actor(context);
    if (!actor.ok) return actor;
    const project = this.#project(projectId);
    if (!project) return fail("NOT_FOUND");
    const invite = this.invites.get(project.id);
    if (!invite || invite.revokedAt || invite.codeHash !== this.#inviteHash(asStr(code, 40).trim().toUpperCase())) return fail("INVALID_INVITE");
    if (project.owner_user_id !== actor.user.id) {
      this.#transact(() => this.store.upsertMember(project.id, actor.user.id, accessToRole(invite.access)));
    }
    return ok({ project: this.publicProject(project, actor.user.id, true) });
  }

  // 源 :226-230 deleteDeveloperCollabProject：既有表用 status='archived' 逻辑删除，引用不悬空。
  deleteProject({ context, projectId } = {}) {
    const actor = this.#actor(context);
    if (!actor.ok) return actor;
    const gate = this.#requireProject(projectId, actor.user.id, "owner");
    if (!gate.ok) return gate;
    this.invites.delete(gate.project.id);
    this.#transact(() => this.store.updateProject(gate.project.id, { status: "archived" }));
    return ok({ deleted: true, projectId: gate.project.id });
  }

  // 源 :232-235 developerCollabRoomAccess：实时房间的准入判定来源（见 developer-realtime.cjs）
  roomAccess({ context, projectId } = {}) {
    const actor = this.#actor(context);
    if (!actor.ok) return actor;
    const gate = this.#requireProject(projectId, actor.user.id, "read");
    if (!gate.ok) return gate;
    const allowedUserIds = [gate.project.owner_user_id, ...this.store.membersOfProject(gate.project.id).map((row) => row.user_id)];
    return ok({ project: gate.project, access: gate.access, allowedUserIds });
  }

  #inviteHash(code) { return crypto.createHash("sha256").update(String(code)).digest("hex"); }

  // 成员目标校验：必须存在、同组织、不是 owner；任一非法则整批拒绝（不半应用）。
  #validateMemberTarget(project, organizationId, userId) {
    if (!userId || userId === project.owner_user_id) return fail("INVALID_INPUT", "member");
    const target = this.identity && typeof this.identity.userById === "function" ? this.identity.userById(userId) : null;
    if (!target || target.team_id !== organizationId) return fail("INVALID_INPUT", "member");
    return null;
  }

  #prepareMembers(project, organizationId, members) {
    const list = Array.isArray(members) ? members.slice(0, MAX_MEMBERS) : [];
    const entries = new Map();
    for (const item of list) {
      if (!item || typeof item !== "object") return fail("INVALID_INPUT", "member");
      const userId = asStr(item.userId, 120);
      const invalid = this.#validateMemberTarget(project, organizationId, userId);
      if (invalid) return invalid;
      entries.set(userId, accessToRole(item.access === "edit" ? "edit" : "read"));
    }
    return { ok: true, entries };
  }
}

// ===========================================================================
// 命令面切片（并入 developer:command）
// ===========================================================================

const DEVELOPER_COLLAB_COMMANDS = Object.freeze([
  { command: "developer/collab/create", risk: "write", credential: "none", summary: "创建协同项目（落既有 projects，owner 为当前会话用户）" },
  { command: "developer/collab/list", risk: "read", credential: "none", summary: "列举当前用户可见的协同项目（owner / 成员 / public）" },
  { command: "developer/collab/get", risk: "read", credential: "none", summary: "读取协同项目（含成员、版本与文档）" },
  { command: "developer/collab/update", risk: "write", credential: "none", summary: "按 baseVersion 更新项目；版本不符返回 VERSION_CONFLICT" },
  { command: "developer/collab/setMembers", risk: "write", credential: "none", summary: "整表替换成员（owner-only，非法成员整批拒绝）" },
  { command: "developer/collab/applyChangeset", risk: "write", credential: "none", summary: "按成员集合基线版本应用变更集（冲突不覆盖）" },
  { command: "developer/collab/setSharing", risk: "write", credential: "none", summary: "设置可见性与公开访问级别（非 restricted 清空成员）" },
  { command: "developer/collab/createInvite", risk: "write", credential: "none", summary: "创建邀请口令（仅进程内哈希存储，不落盘）" },
  { command: "developer/collab/revokeInvite", risk: "write", credential: "none", summary: "撤销当前邀请口令" },
  { command: "developer/collab/redeemInvite", risk: "write", credential: "none", summary: "凭邀请口令加入项目（落 project_members）" },
  { command: "developer/collab/delete", risk: "delete", credential: "none", summary: "归档协同项目（逻辑删除，引用不悬空）" },
  { command: "developer/collab/roomAccess", risk: "read", credential: "none", summary: "计算实时房间准入名单（owner + 成员）" },
]);

const DEVELOPER_COLLAB_REGISTRY = new Map(DEVELOPER_COLLAB_COMMANDS.map((entry) => [entry.command, entry]));

function createDeveloperCollabExtension({ collab = null } = {}) {
  const requireCollab = () => (collab && typeof collab.createProject === "function" ? null : fail("DEVELOPER_COLLAB_UNAVAILABLE", "collab-not-configured"));
  const handlers = {
    "developer/collab/create": (p, c) => collab.createProject({ context: c, name: p.name, kind: p.kind, document: p.document, appId: p.appId }),
    "developer/collab/list": (p, c) => collab.listProjects({ context: c, appId: p.appId }),
    "developer/collab/get": (p, c) => collab.getProject({ context: c, projectId: p.projectId }),
    "developer/collab/update": (p, c) => collab.updateProject({ context: c, projectId: p.projectId, baseVersion: p.baseVersion, name: p.name, kind: p.kind, document: p.document }),
    "developer/collab/setMembers": (p, c) => collab.setMembers({ context: c, projectId: p.projectId, members: p.members }),
    "developer/collab/applyChangeset": (p, c) => collab.applyMemberChangeset({ context: c, projectId: p.projectId, baseRevision: p.baseRevision, changes: p.changes }),
    "developer/collab/setSharing": (p, c) => collab.setSharing({ context: c, projectId: p.projectId, visibility: p.visibility, publicAccess: p.publicAccess, members: p.members }),
    "developer/collab/createInvite": (p, c) => collab.createInvite({ context: c, projectId: p.projectId, access: p.access }),
    "developer/collab/revokeInvite": (p, c) => collab.revokeInvite({ context: c, projectId: p.projectId }),
    "developer/collab/redeemInvite": (p, c) => collab.redeemInvite({ context: c, projectId: p.projectId, code: p.code }),
    "developer/collab/delete": (p, c) => collab.deleteProject({ context: c, projectId: p.projectId }),
    "developer/collab/roomAccess": (p, c) => collab.roomAccess({ context: c, projectId: p.projectId }),
  };
  const dispatch = ({ command, payload, context } = {}) => {
    const entry = DEVELOPER_COLLAB_REGISTRY.get(String(command || ""));
    if (!entry) return fail("DEVELOPER_COMMAND_NOT_ALLOWED", String(command || ""));
    const missing = requireCollab(); if (missing) return missing;
    const handler = handlers[entry.command];
    if (typeof handler !== "function") return fail("NOT_IMPLEMENTED", entry.command);
    try { return handler(payload && typeof payload === "object" ? payload : {}, context || {}); }
    catch (error) { return fail(String((error && error.message) || error)); }
  };
  return { channel: CHANNEL, eventChannel: EVENT_CHANNEL, registry: DEVELOPER_COLLAB_COMMANDS.map((e) => ({ ...e })), commandNames: DEVELOPER_COLLAB_COMMANDS.map((e) => e.command), dispatch, handlers };
}

module.exports = {
  CHANNEL, EVENT_CHANNEL, COLLAB_META_PREFIX, COLLAB_ACCESS, MAX_MEMBERS, MAX_DOCUMENT_BYTES,
  accessToRole, roleToAccess, accessFor, decodeMeta, encodeMeta, memberRevision, cleanName, cleanKind, cleanDocument,
  DeveloperCollabProjects, DEVELOPER_COLLAB_COMMANDS, DEVELOPER_COLLAB_REGISTRY, createDeveloperCollabExtension,
};
