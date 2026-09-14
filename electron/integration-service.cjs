/**
 * D3-04D · Projects / Canvas 集成服务。
 *
 * 硬约束：
 * - 只保存 ResourceRef，不保存绝对路径 / internal object key。
 * - 不建第二套 ACL：项目成员 / Canvas 节点每次访问都重新走 D3-02 Authorization。
 * - 资源 Trash / 删除 / 撤权后，节点与项目引用**保留**但显示真实不可用状态。
 */
"use strict";

const authz = require("./authorization-domain.cjs");

const PROJECT_ROLE = Object.freeze({ VIEWER: "viewer", EDITOR: "editor", MANAGER: "manager" });
const VERSION_MODE = Object.freeze({ PIN_VERSION: "PIN_VERSION", FOLLOW_LATEST: "FOLLOW_LATEST" });
const NODE_STATE = Object.freeze({
  AVAILABLE: "AVAILABLE",
  UNAUTHORIZED: "UNAUTHORIZED",
  DELETED: "DELETED",
  UNAVAILABLE: "UNAVAILABLE",
  VERSION_AVAILABLE: "VERSION_AVAILABLE",
});

class ProjectService {
  constructor({ identity, integrationStore, authService, resourceStore, logger = null } = {}) {
    if (!identity) throw new Error("ProjectService 需要 IdentityStore");
    if (!integrationStore) throw new Error("ProjectService 需要 IntegrationStore");
    if (!authService) throw new Error("ProjectService 需要 AuthorizationService");
    this.identity = identity;
    this.store = integrationStore;
    this.authService = authService;
    this.resourceStore = resourceStore;
    this.logger = logger;
  }

  #actor(context) { return this.authService.resolveActor({ context }); }

  #projectAccess({ project, actor }) {
    if (!project || project.organization_id !== actor.organizationId) return { ok: false, error: "NOT_FOUND_OR_FORBIDDEN" };
    const isOwner = project.owner_user_id === actor.user.id;
    const member = this.store.memberByPair(project.id, actor.user.id);
    const isDeptMember = !!project.department_id && actor.departmentIds.includes(project.department_id);
    const isDeptAdmin = !!project.department_id && actor.adminDeptIds.includes(project.department_id);
    const allowed = actor.isSuper || isOwner || !!member || isDeptMember;
    if (!allowed) return { ok: false, error: "NOT_FOUND_OR_FORBIDDEN" };
    const canManage = actor.isSuper || isOwner || isDeptAdmin || (member && member.role === PROJECT_ROLE.MANAGER);
    return { ok: true, isOwner, member, role: member ? member.role : isOwner ? PROJECT_ROLE.MANAGER : PROJECT_ROLE.VIEWER, canManage, isSuper: actor.isSuper };
  }

  createProject({ context, name, description = "", departmentId = null, scope = "PERSONAL" } = {}) {
    const actor = this.#actor(context);
    if (!actor.ok) return actor;
    const nm = String(name || "").trim();
    if (!nm) return { ok: false, error: "INVALID_INPUT" };
    const scopeCheck = authz.validateScope(scope);
    if (!scopeCheck.ok) return { ok: false, error: "INVALID_INPUT" };
    if (scope === authz.SCOPE.DEPARTMENT) {
      if (!departmentId) return { ok: false, error: "INVALID_INPUT" };
      if (!actor.isSuper && !actor.adminDeptIds.includes(departmentId)) return { ok: false, error: "CROSS_DEPARTMENT_DENIED" };
    }
    if (scope === authz.SCOPE.ORGANIZATION && !actor.isSuper) return { ok: false, error: "NOT_SUPER_ADMIN" };
    const project = this.store.transactSync(() =>
      this.store.insertProject({ organizationId: actor.organizationId, departmentId: scope === authz.SCOPE.DEPARTMENT ? departmentId : null, ownerUserId: actor.user.id, name: nm, description, scope }),
    );
    return { ok: true, project };
  }

  listProjects({ context } = {}) {
    const actor = this.#actor(context);
    if (!actor.ok) return { ...actor, items: [] };
    if (actor.isSuper) return { ok: true, items: this.store.projectsOfOrg(actor.organizationId) };
    const seen = new Map();
    for (const p of [...this.store.projectsOfMember(actor.user.id), ...this.store.projectsOwnedBy(actor.user.id)]) seen.set(p.id, p);
    for (const deptId of actor.departmentIds) for (const p of this.store.projectsOfDepartment(actor.organizationId, deptId)) seen.set(p.id, p);
    return { ok: true, items: [...seen.values()] };
  }

  getProject({ context, projectId } = {}) {
    const actor = this.#actor(context);
    if (!actor.ok) return actor;
    const project = this.store.projectById(projectId);
    const access = this.#projectAccess({ project, actor });
    if (!access.ok) return access;
    return { ok: true, project, role: access.role, canManage: access.canManage, members: this.store.membersOfProject(project.id) };
  }

  addMember({ context, projectId, userId, role = PROJECT_ROLE.VIEWER } = {}) {
    const actor = this.#actor(context);
    if (!actor.ok) return actor;
    const access = this.#projectAccess({ project: this.store.projectById(projectId), actor });
    if (!access.ok) return access;
    if (!access.canManage) return { ok: false, error: "NOT_FOUND_OR_FORBIDDEN" };
    const target = this.identity.userById(userId);
    if (!target || target.team_id !== actor.organizationId) return { ok: false, error: "CROSS_DEPARTMENT_DENIED" };
    if (![PROJECT_ROLE.VIEWER, PROJECT_ROLE.EDITOR, PROJECT_ROLE.MANAGER].includes(String(role))) return { ok: false, error: "INVALID_INPUT" };
    const member = this.store.transactSync(() => this.store.upsertMember(projectId, target.id, String(role)));
    return { ok: true, member };
  }

  removeMember({ context, projectId, userId } = {}) {
    const actor = this.#actor(context);
    if (!actor.ok) return actor;
    const project = this.store.projectById(projectId);
    const access = this.#projectAccess({ project, actor });
    if (!access.ok) return access;
    if (!access.canManage) return { ok: false, error: "NOT_FOUND_OR_FORBIDDEN" };
    if (project.owner_user_id === userId) return { ok: false, error: "INVALID_INPUT" };
    return { ok: true, ...this.store.transactSync(() => this.store.removeMember(projectId, userId)) };
  }

  /** Project 引用 ResourceRef；加入关系本身不绕过 Resource 授权。 */
  addResource({ context, projectId, resourceRef } = {}) {
    const actor = this.#actor(context);
    if (!actor.ok) return actor;
    const access = this.#projectAccess({ project: this.store.projectById(projectId), actor });
    if (!access.ok) return access;
    if (access.role === PROJECT_ROLE.VIEWER) return { ok: false, error: "NOT_FOUND_OR_FORBIDDEN" };
    const resourceId = authz.parseResourceRef(resourceRef);
    if (!resourceId) return { ok: false, error: "INVALID_INPUT" };
    const auth = this.authService.authorize({ context, action: authz.ACTION.VIEW, resource: resourceId });
    if (auth.decision !== "ALLOW") return { ok: false, error: auth.reasonCode || "NOT_FOUND_OR_FORBIDDEN" };
    const link = this.store.transactSync(() => this.store.addProjectResource(projectId, resourceId, actor.user.id));
    return { ok: true, link: { projectId, resourceId: link.resource_id, resourceRef: authz.toResourceRef(link.resource_id) } };
  }

  removeResource({ context, projectId, resourceRef } = {}) {
    const actor = this.#actor(context);
    if (!actor.ok) return actor;
    const access = this.#projectAccess({ project: this.store.projectById(projectId), actor });
    if (!access.ok) return access;
    if (access.role === PROJECT_ROLE.VIEWER) return { ok: false, error: "NOT_FOUND_OR_FORBIDDEN" };
    const resourceId = authz.parseResourceRef(resourceRef);
    if (!resourceId) return { ok: false, error: "INVALID_INPUT" };
    return { ok: true, ...this.store.transactSync(() => this.store.removeProjectResource(projectId, resourceId)) };
  }

  /**
   * 列出项目内资源；逐资源重新授权。
   * 未授权资源只返回 resourceRef + authorized=false，**不泄漏 name / metadata**。
   */
  listProjectResources({ context, projectId } = {}) {
    const actor = this.#actor(context);
    if (!actor.ok) return { ...actor, items: [] };
    const access = this.#projectAccess({ project: this.store.projectById(projectId), actor });
    if (!access.ok) return { ...access, items: [] };
    const links = this.store.resourcesOfProject(projectId);
    const items = links.map((link) => {
      const cap = this.authService.getResource({ context, resource: link.resource_id });
      if (!cap || !cap.ok) {
        return { resourceId: link.resource_id, resourceRef: authz.toResourceRef(link.resource_id), authorized: false, state: "UNAUTHORIZED" };
      }
      return {
        resourceId: link.resource_id,
        resourceRef: authz.toResourceRef(link.resource_id),
        authorized: true,
        state: "AVAILABLE",
        resource: cap.resource,
      };
    });
    return { ok: true, items };
  }

  /** 资源永久删除 / 索引清理时调用：移除项目引用（不改 Project identity）。 */
  removeResourceEverywhere(resourceId) {
    return this.store.transactSync(() => this.store.removeResourceEverywhere(resourceId));
  }
}

class CanvasService {
  constructor({ identity, integrationStore, authService, resourceStore, logger = null } = {}) {
    if (!identity) throw new Error("CanvasService 需要 IdentityStore");
    if (!integrationStore) throw new Error("CanvasService 需要 IntegrationStore");
    if (!authService) throw new Error("CanvasService 需要 AuthorizationService");
    this.identity = identity;
    this.store = integrationStore;
    this.authService = authService;
    this.resourceStore = resourceStore;
    this.logger = logger;
  }

  #actor(context) { return this.authService.resolveActor({ context }); }
  #boardAccess({ board, actor }) {
    if (!board || board.organization_id !== actor.organizationId) return { ok: false, error: "NOT_FOUND_OR_FORBIDDEN" };
    if (actor.isSuper || board.owner_user_id === actor.user.id) return { ok: true, isOwner: true };
    return { ok: false, error: "NOT_FOUND_OR_FORBIDDEN" };
  }

  createBoard({ context, name } = {}) {
    const actor = this.#actor(context);
    if (!actor.ok) return actor;
    const nm = String(name || "").trim();
    if (!nm) return { ok: false, error: "INVALID_INPUT" };
    const board = this.store.transactSync(() => this.store.insertBoard({ organizationId: actor.organizationId, ownerUserId: actor.user.id, name: nm }));
    return { ok: true, board };
  }

  listBoards({ context } = {}) {
    const actor = this.#actor(context);
    if (!actor.ok) return { ...actor, items: [] };
    const items = this.store.boardsOfOrg(actor.organizationId).filter((b) => actor.isSuper || b.owner_user_id === actor.user.id);
    return { ok: true, items };
  }

  #nodeState({ context, node }) {
    const row = this.resourceStore ? this.resourceStore.resourceRowById(node.resource_id) : null;
    if (row && row.trash_state === "TRASHED") return { state: NODE_STATE.UNAVAILABLE };
    if (!row || row.registry_status !== "active") return { state: NODE_STATE.DELETED };
    const auth = this.authService.authorize({ context, action: authz.ACTION.READ, resource: node.resource_id });
    if (auth.decision !== "ALLOW") return { state: NODE_STATE.UNAUTHORIZED };
    const latest = Number(row.version || 1);
    const followsLatest = node.version_mode === VERSION_MODE.FOLLOW_LATEST;
    const effectiveVersion = followsLatest ? latest : Number(node.resource_version || 1);
    const state = !followsLatest && latest > Number(node.resource_version || 1) ? NODE_STATE.VERSION_AVAILABLE : NODE_STATE.AVAILABLE;
    return { state, latestVersion: latest, effectiveVersion, followsLatest };
  }

  getBoard({ context, boardId } = {}) {
    const actor = this.#actor(context);
    if (!actor.ok) return actor;
    const board = this.store.boardById(boardId);
    const access = this.#boardAccess({ board, actor });
    if (!access.ok) return access;
    const nodes = this.store.nodesOfBoard(boardId).map((node) => {
      const st = this.#nodeState({ context, node });
      const base = { nodeId: node.id, resourceId: node.resource_id, resourceRef: authz.toResourceRef(node.resource_id), versionMode: node.version_mode, resourceVersion: node.resource_version, x: node.x, y: node.y, state: st.state, followsLatest: st.state === "UNAUTHORIZED" || st.state === "DELETED" ? undefined : st.followsLatest };
      if (st.state === NODE_STATE.UNAUTHORIZED || st.state === NODE_STATE.DELETED) return base;
      const cap = this.authService.getResource({ context, resource: node.resource_id });
      return { ...base, latestVersion: st.latestVersion, effectiveVersion: st.effectiveVersion, resource: cap.ok ? cap.resource : null };
    });
    return { ok: true, board, nodes };
  }

  addResourceNode({ context, boardId, resourceRef, versionMode = VERSION_MODE.PIN_VERSION, x = 0, y = 0 } = {}) {
    const actor = this.#actor(context);
    if (!actor.ok) return actor;
    const board = this.store.boardById(boardId);
    const access = this.#boardAccess({ board, actor });
    if (!access.ok) return access;
    const resourceId = authz.parseResourceRef(resourceRef);
    if (!resourceId) return { ok: false, error: "INVALID_INPUT" };
    const auth = this.authService.authorize({ context, action: authz.ACTION.READ, resource: resourceId });
    if (auth.decision !== "ALLOW") return { ok: false, error: auth.reasonCode || "NOT_FOUND_OR_FORBIDDEN" };
    if (!Object.values(VERSION_MODE).includes(String(versionMode))) return { ok: false, error: "INVALID_INPUT" };
    const row = this.resourceStore.resourceRowById(resourceId);
    const node = this.store.transactSync(() => this.store.insertNode({ boardId, resourceId, resourceVersion: Number(row.version || 1), versionMode: String(versionMode), x, y, createdBy: actor.user.id }));
    return { ok: true, node };
  }

  /** 显式 "Update to latest"：把 PIN_VERSION 节点升级到当前 Resource 版本。 */
  updateNodeToLatest({ context, nodeId } = {}) {
    const actor = this.#actor(context);
    if (!actor.ok) return actor;
    const node = this.store.nodeById(nodeId);
    if (!node) return { ok: false, error: "NOT_FOUND_OR_FORBIDDEN" };
    const access = this.#boardAccess({ board: this.store.boardById(node.board_id), actor });
    if (!access.ok) return access;
    const row = this.resourceStore.resourceRowById(node.resource_id);
    if (!row || row.registry_status !== "active") return { ok: false, error: "NOT_FOUND_OR_FORBIDDEN" };
    const updated = this.store.transactSync(() => this.store.updateNodeVersion(nodeId, { resourceVersion: Number(row.version || 1), versionMode: VERSION_MODE.PIN_VERSION }));
    return { ok: true, node: updated };
  }

  moveNode({ context, nodeId, x, y } = {}) {
    const actor = this.#actor(context);
    if (!actor.ok) return actor;
    const node = this.store.nodeById(nodeId);
    if (!node) return { ok: false, error: "NOT_FOUND_OR_FORBIDDEN" };
    const access = this.#boardAccess({ board: this.store.boardById(node.board_id), actor });
    if (!access.ok) return access;
    return { ok: true, node: this.store.transactSync(() => this.store.moveNode(nodeId, { x, y })) };
  }

  deleteNode({ context, nodeId } = {}) {
    const actor = this.#actor(context);
    if (!actor.ok) return actor;
    const node = this.store.nodeById(nodeId);
    if (!node) return { ok: true, changed: false };
    const access = this.#boardAccess({ board: this.store.boardById(node.board_id), actor });
    if (!access.ok) return access;
    return { ok: true, ...this.store.transactSync(() => this.store.deleteNode(nodeId)) };
  }
}

module.exports = { ProjectService, CanvasService, PROJECT_ROLE, VERSION_MODE, NODE_STATE };
