/**
 * PhotoCraft 域 · 持久层（identity.db 单库 + dxos-fs 虚拟文件树）。
 *
 * 与 canvas-dxos-store.cjs / media-store.cjs 同一纪律：
 *   · 复用 IdentityStore 的同一条连接与同一个 BEGIN IMMEDIATE 事务队列（不另开库）；
 *   · 只读写 v27 已建好的 photocraft_projects / photocraft_project_members（**不建表、不改
 *     SCHEMA_VERSION**，DDL 真值只有 electron/dxos-foundation-schema.cjs 一份）；
 *   · 项目文件全部落 dxos-fs 虚拟树（源 photocraftProjects.ts:51-59、:112-127），
 *     回收站就是 dxos-fs 自己的 trashed 标记，不另建一套垃圾箱。
 *
 * 源函数对照（行号）：
 *   · :34           row(id)                    → getProject
 *   · :35-37        members(id)                → membersOf
 *   · :51-55        应用根 / 分组根 / 缓存根    → appRoot / groupsRoot / cacheRoot / defaultGroup / cacheFolder
 *   · :56-59        existingCacheFolder        → existingCacheFolder（含已软删节点，靠 fs.json 快照）
 *   · :104-110      listPhotoCraftProjects     → listProjects
 *   · :135-136      项目 INSERT                 → insertProject
 *   · :166-169      项目 UPDATE + 成员重建      → updateProjectMeta / replaceMembers
 *   · :245-265      回收站软删 / 恢复 / 彻底删  → trashProject / restoreProject / purgeProject
 *   · :267-312      fs 根级联                  → trashForFsRoot / restoreForFsRoot / deleteForFsRoot / projectIdsWithinFsRoot
 */
"use strict";

const nodeFs = require("node:fs");
const { randomUUID } = require("node:crypto");
const domain = require("./photocraft-domain.cjs");

const SQL = {
  projectById: "SELECT * FROM photocraft_projects WHERE id=?",
  liveProjectsVisible:
    "SELECT * FROM photocraft_projects WHERE deleted_at IS NULL AND (owner_id=? OR visibility='public' OR id IN (SELECT project_id FROM photocraft_project_members WHERE user_id=?)) ORDER BY updated_at DESC",
  trashedByOwner: "SELECT * FROM photocraft_projects WHERE owner_id=? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC",
  liveProjectsAll: "SELECT * FROM photocraft_projects WHERE deleted_at IS NULL",
  allProjectIds: "SELECT id,owner_id FROM photocraft_projects",
  insertProject:
    "INSERT INTO photocraft_projects(id,group_id,owner_id,title,visibility,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
  updateMeta: "UPDATE photocraft_projects SET group_id=?,title=?,visibility=?,updated_at=? WHERE id=?",
  updateSource: "UPDATE photocraft_projects SET source_node_id=?,title=?,updated_at=? WHERE id=?",
  updatePreview: "UPDATE photocraft_projects SET preview_node_id=?,updated_at=? WHERE id=?",
  updateSourceAndPreview: "UPDATE photocraft_projects SET source_node_id=?,preview_node_id=?,title=?,updated_at=? WHERE id=?",
  trashProject: "UPDATE photocraft_projects SET deleted_at=?,updated_at=? WHERE id=?",
  restoreProject: "UPDATE photocraft_projects SET deleted_at=NULL,updated_at=? WHERE id=?",
  purgeProject: "DELETE FROM photocraft_projects WHERE id=?",
  moveToGroup: "UPDATE photocraft_projects SET group_id=?,updated_at=? WHERE owner_id=? AND group_id=? AND deleted_at IS NULL",
  membersOf: "SELECT user_id FROM photocraft_project_members WHERE project_id=? ORDER BY user_id",
  deleteMembers: "DELETE FROM photocraft_project_members WHERE project_id=?",
  insertMember: "INSERT INTO photocraft_project_members(project_id,user_id) VALUES (?,?)",
  trashForFsRoot: "UPDATE photocraft_projects SET deleted_at=COALESCE(deleted_at,?),updated_at=? WHERE id=?",
  restoreForFsRoot: "UPDATE photocraft_projects SET deleted_at=NULL,updated_at=? WHERE id=?",
};

class PhotocraftStore {
  constructor({ identity, fs, clock, idFactory } = {}) {
    if (!identity || !identity.connection) throw new Error("PhotocraftStore 需要 IdentityStore");
    if (!fs || typeof fs.createNode !== "function" || typeof fs.ensureFolder !== "function") throw new Error("PhotocraftStore 需要 dxos-fs 虚拟文件树");
    this.identity = identity;
    this.db = identity.connection;
    this.fs = fs;
    this.clock = typeof clock === "function" ? clock : typeof identity.clock === "function" ? identity.clock : () => Date.now();
    this.idFactory = typeof idFactory === "function" ? idFactory : randomUUID;
  }

  now() {
    return Number(this.clock());
  }

  /** 连接级同步事务（源 ccsDb.transaction）：事务体内不得有 await。 */
  transact(fn) {
    if (typeof this.identity.transactSync === "function") return this.identity.transactSync(fn);
    return fn();
  }

  // ── 项目行（源 :34、:104-110）────────────────────────────────────────────
  getProject(id) {
    return this.db.prepare(SQL.projectById).get(String(id)) || null;
  }

  listProjects(viewerId, trashed) {
    if (trashed) return this.db.prepare(SQL.trashedByOwner).all(String(viewerId));
    return this.db.prepare(SQL.liveProjectsVisible).all(String(viewerId), String(viewerId));
  }

  /** 源 canViewPhotoCraftFile:317 的 "全部未删除项目" 分支。 */
  liveProjects() {
    return this.db.prepare(SQL.liveProjectsAll).all();
  }

  allProjectIds() {
    return this.db.prepare(SQL.allProjectIds).all();
  }

  insertProject({ id, groupId, ownerId, title, visibility, createdAt, updatedAt }) {
    this.db.prepare(SQL.insertProject).run(String(id), String(groupId), String(ownerId), String(title), String(visibility), Number(createdAt), Number(updatedAt));
    return this.getProject(id);
  }

  updateProjectMeta({ id, groupId, title, visibility, updatedAt }) {
    this.db.prepare(SQL.updateMeta).run(String(groupId), String(title), String(visibility), Number(updatedAt), String(id));
    return this.getProject(id);
  }

  updateSource({ id, sourceNodeId, title, updatedAt }) {
    this.db.prepare(SQL.updateSource).run(sourceNodeId == null ? null : String(sourceNodeId), String(title), Number(updatedAt), String(id));
    return this.getProject(id);
  }

  updatePreview({ id, previewNodeId, updatedAt }) {
    this.db.prepare(SQL.updatePreview).run(previewNodeId == null ? null : String(previewNodeId), Number(updatedAt), String(id));
    return this.getProject(id);
  }

  updateSourceAndPreview({ id, sourceNodeId, previewNodeId, title, updatedAt }) {
    this.db.prepare(SQL.updateSourceAndPreview).run(
      sourceNodeId == null ? null : String(sourceNodeId),
      previewNodeId == null ? null : String(previewNodeId),
      String(title),
      Number(updatedAt),
      String(id),
    );
    return this.getProject(id);
  }

  trashProject({ id, at }) {
    this.db.prepare(SQL.trashProject).run(Number(at), Number(at), String(id));
    return this.getProject(id);
  }

  restoreProject({ id, at }) {
    this.db.prepare(SQL.restoreProject).run(Number(at), String(id));
    return this.getProject(id);
  }

  purgeProject(id) {
    // 依赖 photocraft_project_members 的 ON DELETE CASCADE（PRAGMA foreign_keys=ON，identity-store.cjs:1742）。
    this.db.prepare(SQL.purgeProject).run(String(id));
    return true;
  }

  moveProjectsToGroup({ toGroupId, ownerId, fromGroupId, updatedAt }) {
    const result = this.db.prepare(SQL.moveToGroup).run(String(toGroupId), Number(updatedAt), String(ownerId), String(fromGroupId));
    return Number(result.changes) || 0;
  }

  // ── fs 根级联（源 :284-312）：由 fs 的回收站操作调用，不经过 IPC 命令面 ─────
  markTrashedForFsRoot(id, at) {
    this.db.prepare(SQL.trashForFsRoot).run(Number(at), Number(at), String(id));
  }

  clearTrashedForFsRoot(id, at) {
    this.db.prepare(SQL.restoreForFsRoot).run(Number(at), String(id));
  }

  deleteForFsRoot(id) {
    this.db.prepare(SQL.deleteMembers).run(String(id));
    this.db.prepare(SQL.purgeProject).run(String(id));
  }

  // ── 成员表（源 :35-37、:167-169）─────────────────────────────────────────
  membersOf(projectId) {
    return this.db.prepare(SQL.membersOf).all(String(projectId)).map((row) => String(row.user_id));
  }

  deleteMembers(projectId) {
    this.db.prepare(SQL.deleteMembers).run(String(projectId));
  }

  insertMember(projectId, userId) {
    this.db.prepare(SQL.insertMember).run(String(projectId), String(userId));
  }

  replaceMembers(projectId, userIds) {
    this.deleteMembers(projectId);
    for (const userId of userIds) this.insertMember(projectId, userId);
  }

  // ── fs 根（源 :51-55）────────────────────────────────────────────────────
  appRoot(ownerId) {
    return this.fs.ensureFolder(domain.PHOTOCRAFT_APP_FOLDER, this.fs.ensureCanvasRoot(ownerId).id, ownerId);
  }

  groupsRoot(ownerId) {
    return this.fs.ensureFolder(domain.PHOTOCRAFT_GROUPS_FOLDER, this.appRoot(ownerId), ownerId);
  }

  cacheRoot(ownerId) {
    return this.fs.ensureFolder(domain.PHOTOCRAFT_CACHE_FOLDER, this.appRoot(ownerId), ownerId);
  }

  defaultGroup(ownerId) {
    return this.fs.ensureFolder(domain.PHOTOCRAFT_DEFAULT_GROUP, this.groupsRoot(ownerId), ownerId);
  }

  cacheFolder(ownerId, projectId) {
    return this.fs.ensureFolder(projectId, this.cacheRoot(ownerId), ownerId);
  }

  /**
   * fs.json 全节点快照（含 trashed）。源 readFsNodesSnapshot 读的就是虚拟树自己的 JSON 真值；
   * dxos-fs.cjs 没有把这个内部快照导出，所以这里按同一格式（{format,revision,nodes} 或裸数组）
   * 只读解析 fs.file，不做任何写或缓存。
   */
  readNodesSnapshot() {
    try {
      const file = this.fs.file;
      if (!file || !nodeFs.existsSync(file)) return [];
      const parsed = JSON.parse(nodeFs.readFileSync(file, "utf-8"));
      if (Array.isArray(parsed)) return parsed;
      return parsed && Array.isArray(parsed.nodes) ? parsed.nodes : [];
    } catch {
      return [];
    }
  }

  /** 源 :56-59：缓存目录按 <项目 id> 命名，且必须连同已软删的节点一起找（恢复要用）。 */
  existingCacheFolder(ownerId, projectId) {
    const rootId = this.cacheRoot(ownerId);
    return this.readNodesSnapshot().find((node) => node.parentId === rootId && node.type === "folder" && node.name === projectId) || null;
  }

  /** 源 :62 的 listAuthUsers().find(...).username 等价物（改用单查，避免每行全表）。 */
  userName(userId) {
    if (userId && typeof this.identity.userById === "function") {
      const found = this.identity.userById(userId);
      if (found) return found.display_name || found.identifier || String(userId);
    }
    return "已删除用户";
  }
}

module.exports = { PhotocraftStore, SQL };
