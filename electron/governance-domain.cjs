/**
 * D3-04D · 治理纯领域模型（无 I/O，无 Electron）。
 *
 * 只做"解释"和"影响摘要"，**不做授权判定** —— 判定仍在 AuthorizationService。
 */
"use strict";

const authz = require("./authorization-domain.cjs");

const { SCOPE } = authz;

/** 权限来源标签 → 人类可读解释。 */
const PERMISSION_SOURCE = Object.freeze({
  OWNER_POLICY: "资源 owner 策略",
  ORGANIZATION_POLICY: "组织共享基线（Viewer）",
  DEPARTMENT_MEMBERSHIP: "部门成员继承",
  COLLECTION_GRANT: "Collection 授权",
  EXPLICIT_USER_GRANT: "显式用户授权",
  DEPARTMENT_GRANT: "部门授权",
  APP_GRANT: "App 授权",
  SUPER_ADMIN: "Super Admin 治理",
});

/**
 * 解释"谁为什么能访问这个资源"。
 * 输出的是来源清单，不替代 authorize()。
 */
function explainResourceAccess({ resource, grants = [], appGrants = [] } = {}) {
  if (!resource) return [];
  const sources = [];
  if (resource.owner_user_id) {
    sources.push({ source: "OWNER_POLICY", label: PERMISSION_SOURCE.OWNER_POLICY, subjectType: "USER", subjectId: resource.owner_user_id, actions: [...authz.OWNER_ACTIONS] });
  }
  if (resource.scope === SCOPE.ORGANIZATION) {
    sources.push({ source: "ORGANIZATION_POLICY", label: PERMISSION_SOURCE.ORGANIZATION_POLICY, subjectType: "ORGANIZATION", subjectId: resource.organization_id, actions: [...authz.ORG_POLICY_ACTIONS] });
  }
  for (const g of grants) {
    if (!authz.matchGrant(g, resource)) continue;
    if (g.principal_type === authz.PRINCIPAL.DEPARTMENT) {
      sources.push({ source: "DEPARTMENT_GRANT", label: PERMISSION_SOURCE.DEPARTMENT_GRANT, grantId: g.id, subjectType: "DEPARTMENT", subjectId: g.principal_id, actions: authz.grantActions(g), permissionSet: g.permission_set || null });
    } else if (g.principal_type === authz.PRINCIPAL.USER) {
      const isCollection = !g.resource_id && !!g.collection_id;
      sources.push({ source: isCollection ? "COLLECTION_GRANT" : "EXPLICIT_USER_GRANT", label: isCollection ? PERMISSION_SOURCE.COLLECTION_GRANT : PERMISSION_SOURCE.EXPLICIT_USER_GRANT, grantId: g.id, subjectType: "USER", subjectId: g.principal_id, actions: authz.grantActions(g), permissionSet: g.permission_set || null, collectionId: g.collection_id || null });
    }
  }
  for (const g of appGrants) {
    if (!authz.appGrantCoversResource(g, resource)) continue;
    sources.push({
      source: "APP_GRANT",
      label: PERMISSION_SOURCE.APP_GRANT,
      grantId: g.id,
      subjectType: "APP",
      subjectId: g.app_id,
      actions: authz.grantActions(g),
      collectionId: g.collection_id || null,
      resourceType: g.resource_type || null,
      departmentId: g.department_id || null,
      scope: g.scope || null,
      expiresAt: g.expires_at || null,
    });
  }
  return sources;
}

/** 某主体的有效动作集合（纯函数解释，不替代 authorize）。 */
function effectiveActionsFor({ resource, user, memberships = [], grants = [] } = {}) {
  const result = authz.evaluateUserAuthorization({ resource, user, memberships, grants });
  return { actions: [...result.actions].sort(), sources: [...result.sources].sort(), denied: result.denied || null, isOwner: !!result.isOwner };
}

/**
 * Scope 变更影响摘要。
 *
 * 计算"谁能访问"在变更前后的差集（基于 ORGANIZATION 全组织 / DEPARTMENT 成员 / 显式 USER grant / owner）。
 * 只用于预览与确认，不是授权权威。
 */
function scopeChangeImpact({ resource, scope, departmentId = null, users = [], memberships = [], grants = [], appGrants = [] } = {}) {
  if (!resource) return null;
  const memberIdsOf = (deptId) => new Set(memberships.filter((m) => m.department_id === deptId && m.status === "ACTIVE").map((m) => m.user_id));
  const accessSet = (sc, deptId) => {
    const set = new Set();
    if (resource.owner_user_id) set.add(resource.owner_user_id);
    if (sc === SCOPE.ORGANIZATION) for (const u of users) set.add(u.id);
    if (sc === SCOPE.DEPARTMENT && deptId) for (const id of memberIdsOf(deptId)) set.add(id);
    for (const g of grants) if (g.principal_type === authz.PRINCIPAL.USER && authz.matchGrant(g, resource)) set.add(g.principal_id);
    return set;
  };
  const before = accessSet(resource.scope, resource.department_id);
  const after = accessSet(scope, departmentId);
  const willGain = users.filter((u) => !before.has(u.id) && after.has(u.id)).map((u) => ({ userId: u.id, identifier: u.identifier }));
  const willLose = users.filter((u) => before.has(u.id) && !after.has(u.id)).map((u) => ({ userId: u.id, identifier: u.identifier }));
  const departmentGrantsAffected = grants.filter((g) => g.principal_type === authz.PRINCIPAL.DEPARTMENT && authz.matchGrant(g, resource));
  const appGrantsAffected = appGrants.filter((g) => authz.appGrantCoversResource(g, resource));
  return {
    resourceId: resource.resource_id,
    fromScope: resource.scope,
    fromDepartmentId: resource.department_id || null,
    toScope: scope,
    toDepartmentId: departmentId || null,
    willGain,
    willLose,
    departmentGrantsAffected: departmentGrantsAffected.length,
    appGrantsAffected: appGrantsAffected.length,
    explicitUserGrantsRetained: grants.filter((g) => g.principal_type === authz.PRINCIPAL.USER && authz.matchGrant(g, resource)).length,
    incomingReferences: 0,
    note: "DEPARTMENT 继承 grant 会被移除；显式 USER / APP grant 保留并由 D3-02 重新求值；下一请求立即生效。",
  };
}

module.exports = { PERMISSION_SOURCE, explainResourceAccess, effectiveActionsFor, scopeChangeImpact };
