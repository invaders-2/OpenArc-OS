/**
 * D3-04D · 治理服务（Organization / Department / User / Resource / App / Audit）。
 *
 * 原则：
 * - 只读/写**治理投影**，授权判定仍复用 AuthorizationService；
 * - 绝不返回 password hash / salt / params / session token / device key；
 * - 每次写操作都产生 authorization_audit。
 */
"use strict";

const crypto = require("node:crypto");
const authzDom = require("./authorization-domain.cjs");
const govDom = require("./governance-domain.cjs");

class GovernanceService {
  constructor({ identity, authService, authStore, resourceStore, integrationStore = null, logger = null } = {}) {
    if (!identity) throw new Error("GovernanceService 需要 IdentityStore");
    if (!authService) throw new Error("GovernanceService 需要 AuthorizationService");
    if (!authStore) throw new Error("GovernanceService 需要 AuthorizationStore");
    if (!resourceStore) throw new Error("GovernanceService 需要 ResourceStore");
    this.identity = identity;
    this.authService = authService;
    this.authStore = authStore;
    this.resourceStore = resourceStore;
    this.integrationStore = integrationStore;
    this.logger = logger;
  }

  #actor(context) { return this.authService.resolveActor({ context }); }

  /** 治理入口：Super Admin 或 Department Admin；普通用户一律 DENY。 */
  #adminGate(context) {
    const actor = this.#actor(context);
    if (!actor.ok) return { ok: false, error: "NOT_FOUND_OR_FORBIDDEN" };
    if (!actor.isSuper && actor.adminDeptIds.length === 0) return { ok: false, error: "NOT_SUPER_ADMIN" };
    return actor;
  }

  #safeUser(user, memberships) {
    if (!user) return null;
    const depts = (memberships || []).map((m) => {
      const dept = this.authStore.departmentById(m.department_id);
      return { departmentId: m.department_id, name: dept ? dept.name : null, role: m.membership_role, status: m.status };
    });
    return {
      userId: user.id,
      identifier: user.identifier,
      displayName: user.display_name,
      role: user.role,
      status: user.status,
      createdAt: user.created_at,
      updatedAt: user.updated_at,
      departments: depts,
    };
  }

  #orgUsers(orgId) { return this.identity.allUsers().filter((u) => u.team_id === orgId); }
  #allMemberships() {
    const out = [];
    for (const u of this.identity.allUsers()) out.push(...this.authStore.membershipsOfUser(u.id));
    return out;
  }

  // --- Users ---

  listUsers({ context } = {}) {
    const actor = this.#adminGate(context);
    if (!actor.ok) return { ok: false, error: actor.error, items: [] };
    const memberships = this.#allMemberships();
    let users = this.#orgUsers(actor.organizationId);
    if (!actor.isSuper) {
      users = users.filter((u) => memberships.some((m) => m.user_id === u.id && actor.adminDeptIds.includes(m.department_id)));
    }
    const items = users.map((u) => this.#safeUser(u, memberships.filter((m) => m.user_id === u.id)));
    return { ok: true, items };
  }

  getUserDetail({ context, userId } = {}) {
    const actor = this.#adminGate(context);
    if (!actor.ok) return { ok: false, error: actor.error };
    const user = this.identity.userById(userId);
    if (!user || user.team_id !== actor.organizationId) return { ok: false, error: "NOT_FOUND_OR_FORBIDDEN" };
    const memberships = this.authStore.membershipsOfUser(user.id);
    if (!actor.isSuper && !memberships.some((m) => actor.adminDeptIds.includes(m.department_id))) return { ok: false, error: "NOT_FOUND_OR_FORBIDDEN" };
    const owned = this.authStore.listRegistry(actor.organizationId).filter((r) => r.owner_user_id === user.id);
    return { ok: true, user: this.#safeUser(user, memberships), ownedResources: owned.length };
  }

  /** 便捷委托（测试 / UI 统一走 GovernanceService）。 */
  async createUser({ context, identifier, password, displayName, role } = {}) {
    return this.authService.createUser({ context, identifier, password, displayName, role });
  }

  setUserStatus({ context, userId, status } = {}) { return this.authService.setUserStatus({ context, userId, status }); }
  setUserRole({ context, userId, role } = {}) { return this.authService.setUserRole({ context, userId, role }); }
  createDepartment({ context, name, description } = {}) { return this.authService.createDepartment({ context, name, description }); }
  updateDepartment({ context, departmentId, name, description, status } = {}) { return this.authService.updateDepartment({ context, departmentId, name, description, status }); }
  addDepartmentMember({ context, departmentId, userId, membershipRole } = {}) { return this.authService.addDepartmentMember({ context, departmentId, userId, membershipRole }); }
  removeDepartmentMember({ context, departmentId, userId } = {}) { return this.authService.removeDepartmentMember({ context, departmentId, userId }); }

  moveUserDepartment({ context, userId, fromDepartmentId, toDepartmentId } = {}) {
    const actor = this.#adminGate(context);
    if (!actor.ok) return { ok: false, error: actor.error };
    const user = this.identity.userById(userId);
    if (!user || user.team_id !== actor.organizationId) return { ok: false, error: "NOT_FOUND_OR_FORBIDDEN" };
    const toDept = this.authStore.departmentById(toDepartmentId);
    if (!toDept || toDept.organization_id !== actor.organizationId) return { ok: false, error: "CROSS_DEPARTMENT_DENIED" };
    if (!actor.isSuper) {
      if (!actor.adminDeptIds.includes(toDept.id)) return { ok: false, error: "CROSS_DEPARTMENT_DENIED" };
      if (fromDepartmentId && !actor.adminDeptIds.includes(fromDepartmentId)) return { ok: false, error: "CROSS_DEPARTMENT_DENIED" };
    }
    const before = fromDepartmentId ? this.authStore.membershipByPair(fromDepartmentId, user.id) : null;
    this.authStore.transactSync(() => {
      if (before) this.authStore.removeMembership(fromDepartmentId, user.id);
      this.authStore.upsertMembership({ departmentId: toDept.id, organizationId: toDept.organization_id, userId: user.id, membershipRole: authzDom.MEMBERSHIP_ROLE.MEMBER, status: "ACTIVE" });
    });
    this.authStore.auditAuthorization({
      actorUserId: actor.user.id, targetUserId: user.id, appId: null, departmentId: toDept.id, resourceRef: null,
      action: "governance.moveDepartment", decision: "ALLOW", reasonCode: "ALLOW",
      permissionSource: actor.isSuper ? authzDom.ALLOW_SOURCE.SUPER_ADMIN : authzDom.ALLOW_SOURCE.DEPARTMENT_ADMIN,
      oldPermissions: fromDepartmentId ? [fromDepartmentId] : [], newPermissions: [toDept.id],
    });
    return { ok: true, userId: user.id, fromDepartmentId: fromDepartmentId || null, toDepartmentId: toDept.id, membership: this.authStore.membershipByPair(toDept.id, user.id) };
  }

  async initiatePasswordReset({ context, userId } = {}) {
    const actor = this.#actor(context);
    if (!actor.ok) return actor;
    if (!actor.isSuper) return { ok: false, error: "NOT_SUPER_ADMIN" };
    const user = this.identity.userById(userId);
    if (!user || user.team_id !== actor.organizationId) return { ok: false, error: "NOT_FOUND_OR_FORBIDDEN" };
    const temporaryPassword = crypto.randomBytes(12).toString("base64url");
    const res = await this.identity.adminSetPassword({ userId: user.id, newPassword: temporaryPassword });
    this.authStore.auditAuthorization({
      actorUserId: actor.user.id, targetUserId: user.id, appId: null, departmentId: null, resourceRef: null,
      action: "governance.passwordReset", decision: res.ok ? "ALLOW" : "DENY", reasonCode: res.ok ? "ALLOW" : res.error,
      permissionSource: authzDom.ALLOW_SOURCE.SUPER_ADMIN, oldPermissions: [], newPermissions: [],
    });
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, userId: user.id, revokedSessions: res.revokedSessions, temporaryPassword };
  }

  // --- Departments ---

  listDepartments({ context } = {}) {
    const actor = this.#adminGate(context);
    if (!actor.ok) return { ok: false, error: actor.error, items: [] };
    const all = this.authStore.departmentsOfOrg(actor.organizationId);
    const visible = actor.isSuper ? all : all.filter((d) => actor.adminDeptIds.includes(d.id));
    const registry = this.authStore.listRegistry(actor.organizationId);
    const collections = this.authStore.collectionsOfOrg(actor.organizationId);
    const grants = this.authStore.grantsForOrganizationContext(actor.organizationId);
    const items = visible.map((d) => ({
      departmentId: d.id,
      name: d.name,
      description: d.description,
      status: d.status,
      memberCount: this.authStore.membershipsOfDepartment(d.id).length,
      resourceCount: registry.filter((r) => r.department_id === d.id).length,
      collectionCount: collections.filter((c) => c.department_id === d.id).length,
      grantCount: grants.filter((g) => g.department_id === d.id || (g.principal_type === authzDom.PRINCIPAL.DEPARTMENT && g.principal_id === d.id)).length,
    }));
    return { ok: true, items };
  }

  getDepartmentDetail({ context, departmentId } = {}) {
    const actor = this.#adminGate(context);
    if (!actor.ok) return { ok: false, error: actor.error };
    const dept = this.authStore.departmentById(departmentId);
    if (!dept || dept.organization_id !== actor.organizationId) return { ok: false, error: "NOT_FOUND_OR_FORBIDDEN" };
    if (!actor.isSuper && !actor.adminDeptIds.includes(dept.id)) return { ok: false, error: "CROSS_DEPARTMENT_DENIED" };
    const memberships = this.authStore.membershipsOfDepartment(dept.id);
    const members = memberships.map((m) => this.#safeUser(this.identity.userById(m.user_id), [m]));
    const resources = this.authStore.listRegistry(actor.organizationId).filter((r) => r.department_id === dept.id).map((r) => ({ resourceId: r.resource_id, resourceRef: authzDom.toResourceRef(r.resource_id), name: r.name, resourceType: r.resource_type }));
    const collections = this.authStore.collectionsOfOrg(actor.organizationId).filter((c) => c.department_id === dept.id);
    const grants = this.authStore.grantsForOrganizationContext(actor.organizationId).filter((g) => g.department_id === dept.id || (g.principal_type === authzDom.PRINCIPAL.DEPARTMENT && g.principal_id === dept.id));
    return { ok: true, department: { departmentId: dept.id, name: dept.name, description: dept.description, status: dept.status, createdAt: dept.created_at }, members, resources, collections, grantCount: grants.length };
  }

  /** 部门删除前安全检查：仍有成员 / 资源 / collection / grant 时拒绝。 */
  deleteDepartment({ context, departmentId } = {}) {
    const gate = this.#adminGate(context);
    if (!gate.ok) return { ok: false, error: gate.error };
    if (!gate.isSuper) return { ok: false, error: "NOT_SUPER_ADMIN" };
    const detail = this.getDepartmentDetail({ context, departmentId });
    if (!detail.ok) return { ok: false, error: detail.error };
    const counts = { members: detail.members.length, resources: detail.resources.length, collections: detail.collections.length, grants: detail.grantCount };
    const blockers = Object.entries(counts).filter(([, v]) => v > 0).map(([k]) => k);
    if (blockers.length) return { ok: false, error: "DEPARTMENT_NOT_EMPTY", blockers, counts };
    this.authStore.transactSync(() => this.authStore.db.prepare("DELETE FROM departments WHERE id = ?").run(String(departmentId)));
    this.authStore.auditAuthorization({
      actorUserId: gate.user.id, targetUserId: null, appId: null, departmentId, resourceRef: null,
      action: "governance.deleteDepartment", decision: "ALLOW", reasonCode: "ALLOW", permissionSource: authzDom.ALLOW_SOURCE.SUPER_ADMIN, oldPermissions: [departmentId], newPermissions: [],
    });
    return { ok: true, changed: true };
  }

  // --- Resource access ---

  listResourceAccess({ context, resourceRef } = {}) {
    const actor = this.#actor(context);
    if (!actor.ok) return actor;
    const resourceId = authzDom.parseResourceRef(resourceRef);
    if (!resourceId) return { ok: false, error: "INVALID_INPUT" };
    const row = this.authStore.resourceById(resourceId);
    if (!row || row.organization_id !== actor.organizationId) return { ok: false, error: "NOT_FOUND_OR_FORBIDDEN" };
    // Super Admin 拥有治理权（D3-04D §6）；Department Admin 可管理本部门资源。
    const isDeptAdminForResource = !!row.department_id && actor.adminDeptIds.includes(row.department_id);
    if (!actor.isSuper && !isDeptAdminForResource) {
      const manage = this.authService.authorize({ context, action: authzDom.ACTION.MANAGE_ACCESS, resource: resourceId });
      if (manage.decision !== "ALLOW") return { ok: false, error: "NOT_FOUND_OR_FORBIDDEN" };
    }
    const grants = this.authStore.grantsForOrganizationContext(actor.organizationId).filter((g) => authzDom.matchGrant(g, row));
    const appGrants = this.authStore.allAppGrants().filter((g) => g.organization_id === actor.organizationId && authzDom.appGrantCoversResource(g, row));
    const sources = govDom.explainResourceAccess({ resource: row, grants, appGrants });
    const owner = row.owner_user_id ? this.#safeUser(this.identity.userById(row.owner_user_id), this.authStore.membershipsOfUser(row.owner_user_id)) : null;
    return {
      ok: true,
      resource: { resourceId: row.resource_id, resourceRef: authzDom.toResourceRef(row.resource_id), name: row.name, resourceType: row.resource_type, scope: row.scope, departmentId: row.department_id || null, collectionId: row.collection_id || null, ownerUserId: row.owner_user_id || null, version: row.version },
      owner,
      sources,
      grants: grants.map((g) => ({ grantId: g.id, principalType: g.principal_type, principalId: g.principal_id, actions: authzDom.grantActions(g), permissionSet: g.permission_set || null, collectionId: g.collection_id || null, resourceType: g.resource_type || null })),
      appGrants: appGrants.map((g) => ({ grantId: g.id, appId: g.app_id, actions: authzDom.grantActions(g), resourceType: g.resource_type || null, collectionId: g.collection_id || null, departmentId: g.department_id || null, scope: g.scope || null, expiresAt: g.expires_at || null })),
      agentAccess: (authzDom.grantActions(row) || []).includes(authzDom.ACTION.USE_BY_AGENT) || !!row.owner_user_id,
    };
  }

  previewScopeChange({ context, resourceRef, scope, departmentId = null } = {}) {
    const actor = this.#actor(context);
    if (!actor.ok) return actor;
    const resourceId = authzDom.parseResourceRef(resourceRef);
    if (!resourceId) return { ok: false, error: "INVALID_INPUT" };
    const row = this.authStore.resourceById(resourceId);
    if (!row || row.organization_id !== actor.organizationId) return { ok: false, error: "NOT_FOUND_OR_FORBIDDEN" };
    if (!actor.isSuper) {
      const manage = this.authService.authorize({ context, action: authzDom.ACTION.MANAGE_ACCESS, resource: resourceId });
      if (manage.decision !== "ALLOW") return { ok: false, error: "NOT_FOUND_OR_FORBIDDEN" };
    }
    const users = this.#orgUsers(actor.organizationId);
    const memberships = this.#allMemberships();
    const grants = this.authStore.grantsForOrganizationContext(actor.organizationId).filter((g) => authzDom.matchGrant(g, row));
    const appGrants = this.authStore.allAppGrants().filter((g) => g.organization_id === actor.organizationId && authzDom.appGrantCoversResource(g, row));
    const incomingReferences = this.integrationStore ? this.integrationStore.projectsOfResource(resourceId).length + this.integrationStore.nodesOfResource(resourceId).length : 0;
    const impact = govDom.scopeChangeImpact({ resource: row, scope, departmentId, users, memberships, grants, appGrants });
    if (impact) impact.incomingReferences = incomingReferences;
    return { ok: true, impact };
  }

  changeScope({ context, resourceRef, scope, departmentId = null, collectionId = null } = {}) {
    const resourceId = authzDom.parseResourceRef(resourceRef);
    if (!resourceId) return { ok: false, error: "INVALID_INPUT" };
    return this.authService.changeResourceScope({ context, resourceId, scope, departmentId, collectionId });
  }

  // --- Apps ---

  evaluateAppPermissionUpgrade({ currentActions = [], requestedActions = [] } = {}) {
    return this.authService.evaluateAppPermissionUpgrade({ currentActions, requestedActions });
  }

  listApps({ context } = {}) {
    const gate = this.#adminGate(context);
    if (!gate.ok) return { ok: false, error: gate.error, items: [] };
    const apps = this.authStore.allApps();
    const grants = this.authStore.allAppGrants().filter((g) => g.organization_id === gate.organizationId);
    const items = apps.map((a) => ({
      appId: a.app_id,
      name: a.name,
      publisher: a.publisher,
      status: a.status,
      builtIn: !!a.built_in,
      grantCount: grants.filter((g) => g.app_id === a.app_id).length,
      memoryAccess: grants.some((g) => g.app_id === a.app_id && g.resource_type === "memory"),
    }));
    return { ok: true, items };
  }

  getAppAccess({ context, appId } = {}) {
    const gate = this.#adminGate(context);
    if (!gate.ok) return { ok: false, error: gate.error };
    const app = this.authStore.appById(appId);
    if (!app) return { ok: false, error: "APP_UNKNOWN" };
    const grants = this.authStore.appGrantsForApp(appId).filter((g) => g.organization_id === gate.organizationId);
    return {
      ok: true,
      app: { appId: app.app_id, name: app.name, publisher: app.publisher, status: app.status, builtIn: !!app.built_in },
      grants: grants.map((g) => ({ grantId: g.id, actions: authzDom.grantActions(g), resourceId: g.resource_id || null, collectionId: g.collection_id || null, resourceType: g.resource_type || null, departmentId: g.department_id || null, scope: g.scope || null, expiresAt: g.expires_at || null })),
      memoryGrants: grants.filter((g) => g.resource_type === "memory").length,
    };
  }

  grantAppAccess({ context, appId, ...rest } = {}) { return this.authService.grantAppResourcePermission({ context, appId, ...rest }); }
  revokeAppAccess({ context, grantId } = {}) { return this.authService.revokeAppResourcePermission({ context, grantId }); }
  setAppStatus({ context, appId, status } = {}) { return this.authService.setAppStatus({ context, appId, status }); }

  // --- Resource grants ---

  grantResourceAccess({ context, ...rest } = {}) { return this.authService.grantResourcePermission({ context, ...rest }); }
  revokeResourceAccess({ context, grantId } = {}) { return this.authService.revokeResourcePermission({ context, grantId }); }

  /** 批量授予：逐项返回 success / denied / conflict / no-change。绝不 "部分失败显示全部成功"。 */
  bulkGrant({ context, principalType, principalIds = [], resourceId = null, collectionId = null, resourceType = null, departmentId = null, actions = null, permissionSet = null } = {}) {
    const actor = this.#adminGate(context);
    if (!actor.ok) return { ok: false, error: actor.error, results: [] };
    const results = [];
    for (const principalId of principalIds) {
      const res = this.authService.grantResourcePermission({ context, principalType, principalId, resourceId, collectionId, resourceType, departmentId, actions, permissionSet });
      let status;
      if (!res.ok) status = res.error === "SELF_ESCALATION_DENIED" ? "denied" : res.error === "DELEGATION_EXCEEDS_AUTHORITY" ? "denied" : "denied";
      else if (res.created === false) status = "no-change";
      else status = "success";
      results.push({ principalId, status, grantId: res.grant ? res.grant.id : null, error: res.ok ? null : res.error, missing: res.missing || null });
    }
    return { ok: results.some((r) => r.status === "success") || results.length === 0, results };
  }

  bulkRevoke({ context, grantIds = [] } = {}) {
    const actor = this.#adminGate(context);
    if (!actor.ok) return { ok: false, error: actor.error, results: [] };
    const results = grantIds.map((grantId) => {
      const res = this.authService.revokeResourcePermission({ context, grantId });
      if (!res.ok) return { grantId, status: "denied", error: res.error };
      return { grantId, status: res.changed === false ? "no-change" : "success", error: null };
    });
    return { ok: true, results };
  }

  transferOwnership({ context, resourceId, newOwnerUserId } = {}) {
    return this.authService.transferResourceOwnership({ context, resourceId, newOwnerUserId });
  }

  bulkTransferOwnership({ context, resourceIds = [], newOwnerUserId } = {}) {
    const actor = this.#adminGate(context);
    if (!actor.ok) return { ok: false, error: actor.error, results: [] };
    const results = resourceIds.map((resourceId) => {
      const res = this.authService.transferResourceOwnership({ context, resourceId, newOwnerUserId });
      return { resourceId, status: res.ok ? "success" : "denied", error: res.ok ? null : res.error };
    });
    return { ok: results.every((r) => r.status === "success"), results };
  }

  // --- Audit ---

  listAudit({ context, filter = {}, limit = 200 } = {}) {
    const gate = this.#adminGate(context);
    if (!gate.ok) return { ok: false, error: gate.error, items: [] };
    const all = this.authStore.authorizationAudit();
    const visible = gate.isSuper ? all : all.filter((a) => a.department_id && gate.adminDeptIds.includes(a.department_id));
    const f = filter || {};
    const items = visible
      .filter((a) => {
        if (f.actorUserId && a.actor_user_id !== f.actorUserId) return false;
        if (f.targetUserId && a.target_user_id !== f.targetUserId) return false;
        if (f.appId && a.app_id !== f.appId) return false;
        if (f.departmentId && a.department_id !== f.departmentId) return false;
        if (f.resourceRef && a.resource_ref !== f.resourceRef) return false;
        if (f.action && String(a.action) !== String(f.action)) return false;
        if (f.decision && String(a.decision) !== String(f.decision)) return false;
        if (f.sinceAt != null && Number(a.at) < Number(f.sinceAt)) return false;
        return true;
      })
      .slice(0, Math.max(1, Math.min(1000, Number(limit) || 200)))
      .map((a) => ({ at: a.at, actorUserId: a.actor_user_id, targetUserId: a.target_user_id, appId: a.app_id, departmentId: a.department_id, resourceRef: a.resource_ref, action: a.action, decision: a.decision, reasonCode: a.reason_code, permissionSource: a.permission_source, oldPermissions: a.old_permissions, newPermissions: a.new_permissions, requestId: a.request_id }));
    return { ok: true, items, total: items.length };
  }
}

module.exports = { GovernanceService };
