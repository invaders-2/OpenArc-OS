/**
 * D3-02 · Authorization 持久层。
 *
 * **不是第二套数据库权威**：它复用 IdentityStore 的同一条连接（identity.connection）
 * 与同一个连接内事务队列（identity.transact / transactSync），因此
 * Resource / Grant / Department 的写入与身份写入共享同一套 SQLite 写锁与原子性。
 *
 * 只保存授权所需的身份信息：Resource Registry 里没有文件路径、thumbnail、
 * 媒体 metadata —— 那些属 D3-04。Grant 的行级唯一约束保证"不可解释的重复权限"
 * 在数据库层就不可能存在（§50）。
 */
"use strict";

const domain = require("./authorization-domain.cjs");
const { ok, fail, newId, REASON, PRINCIPAL, SCOPE } = domain;

const SQL = {
  insertDepartment:
    "INSERT INTO departments (id, organization_id, name, description, status, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
  departmentById: "SELECT * FROM departments WHERE id = ?",
  departmentsOfOrg: "SELECT * FROM departments WHERE organization_id = ? ORDER BY created_at, id",
  updateDepartment: "UPDATE departments SET name = ?, description = ?, status = ?, updated_at = ? WHERE id = ?",

  upsertMembership:
    "INSERT INTO department_memberships (id, department_id, organization_id, user_id, membership_role, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?) " +
    "ON CONFLICT(department_id, user_id) DO UPDATE SET membership_role = excluded.membership_role, status = excluded.status, updated_at = excluded.updated_at",
  membershipByPair: "SELECT * FROM department_memberships WHERE department_id = ? AND user_id = ?",
  membershipsOfUser: "SELECT * FROM department_memberships WHERE user_id = ? ORDER BY created_at, id",
  membershipsOfDepartment: "SELECT * FROM department_memberships WHERE department_id = ? ORDER BY created_at, id",
  setMembershipStatus: "UPDATE department_memberships SET status = ?, updated_at = ? WHERE department_id = ? AND user_id = ?",
  deleteMembership: "DELETE FROM department_memberships WHERE department_id = ? AND user_id = ?",

  insertCollection:
    "INSERT INTO collections (id, organization_id, department_id, owner_user_id, name, description, scope, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  collectionById: "SELECT * FROM collections WHERE id = ?",
  collectionsOfOrg: "SELECT * FROM collections WHERE organization_id = ? ORDER BY created_at, id",
  updateCollection: "UPDATE collections SET name = ?, description = ?, updated_at = ? WHERE id = ?",
  setCollectionStatus: "UPDATE collections SET status = ?, updated_at = ? WHERE id = ?",

  insertResource:
    "INSERT INTO resource_registry (resource_id, resource_type, owner_user_id, organization_id, department_id, collection_id, scope, parent_resource_id, name, description, tags, version, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  resourceById: "SELECT * FROM resource_registry WHERE resource_id = ?",
  updateResource:
    "UPDATE resource_registry SET resource_type = ?, owner_user_id = ?, organization_id = ?, department_id = ?, collection_id = ?, scope = ?, parent_resource_id = ?, name = ?, description = ?, tags = ?, version = ?, status = ?, updated_at = ? WHERE resource_id = ?",
  setResourceStatus: "UPDATE resource_registry SET status = ?, updated_at = ?, version = version + 1 WHERE resource_id = ?",
  setResourceOwner: "UPDATE resource_registry SET owner_user_id = ?, updated_at = ?, version = version + 1 WHERE resource_id = ?",
  reparentResource: "UPDATE resource_registry SET department_id = ?, organization_id = ?, scope = ?, collection_id = ?, updated_at = ?, version = version + 1 WHERE resource_id = ?",
  listRegistryByOrg: "SELECT * FROM resource_registry WHERE organization_id = ? AND status = 'active' ORDER BY created_at, resource_id",
  searchRegistry: "SELECT * FROM resource_registry WHERE organization_id = ? AND status = 'active' AND (name LIKE ? OR description LIKE ? OR tags LIKE ?) ORDER BY created_at, resource_id",

  upsertResourceGrant:
    "INSERT INTO resource_grants (id, principal_type, principal_id, resource_id, collection_id, resource_type, department_id, scope, actions, permission_set, granted_by, organization_id, created_at, updated_at) " +
    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) " +
    "ON CONFLICT(principal_type, principal_id, resource_id, collection_id, resource_type, department_id, scope) DO UPDATE SET actions = excluded.actions, permission_set = excluded.permission_set, granted_by = excluded.granted_by, updated_at = excluded.updated_at",
  resourceGrantById: "SELECT * FROM resource_grants WHERE id = ?",
  resourceGrantByKey:
    "SELECT * FROM resource_grants WHERE principal_type = ? AND principal_id = ? AND resource_id = ? AND collection_id = ? AND resource_type = ? AND department_id = ? AND scope = ?",
  grantsForPrincipals:
    "SELECT * FROM resource_grants WHERE organization_id = ? ORDER BY created_at, id",
  grantsForResource: "SELECT * FROM resource_grants WHERE resource_id = ?",
  deleteResourceGrant: "DELETE FROM resource_grants WHERE id = ?",
  deleteDepartmentGrantsForResource:
    "DELETE FROM resource_grants WHERE principal_type = 'DEPARTMENT' AND (resource_id = ? OR (collection_id <> '' AND collection_id = ?))",
  deleteGrantsForResource: "DELETE FROM resource_grants WHERE resource_id = ? OR collection_id = ?",

  upsertApp:
    "INSERT INTO app_principals (app_id, name, publisher, status, built_in, created_at, updated_at) VALUES (?,?,?,?,?,?,?) " +
    "ON CONFLICT(app_id) DO UPDATE SET name = excluded.name, publisher = excluded.publisher, status = excluded.status, updated_at = excluded.updated_at",
  appById: "SELECT * FROM app_principals WHERE app_id = ?",
  allApps: "SELECT * FROM app_principals ORDER BY app_id",
  setAppStatus: "UPDATE app_principals SET status = ?, updated_at = ? WHERE app_id = ?",

  upsertAppGrant:
    "INSERT INTO app_resource_grants (id, app_id, resource_id, collection_id, resource_type, department_id, scope, actions, granted_by, organization_id, created_at, expires_at) " +
    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?) " +
    "ON CONFLICT(app_id, resource_id, collection_id, resource_type, department_id, scope) DO UPDATE SET actions = excluded.actions, granted_by = excluded.granted_by, organization_id = excluded.organization_id, created_at = excluded.created_at, expires_at = excluded.expires_at",
  appGrantById: "SELECT * FROM app_resource_grants WHERE id = ?",
  appGrantsForApp: "SELECT * FROM app_resource_grants WHERE app_id = ? ORDER BY created_at, id",
  allAppGrants: "SELECT * FROM app_resource_grants ORDER BY created_at, id",
  deleteAppGrant: "DELETE FROM app_resource_grants WHERE id = ?",
  deleteAppGrantsForResource: "DELETE FROM app_resource_grants WHERE resource_id = ? OR collection_id = ?",

  insertAuthzAudit:
    "INSERT INTO authorization_audit (at, actor_user_id, target_user_id, app_id, department_id, resource_ref, action, decision, reason_code, permission_source, request_id, old_permissions, new_permissions) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
  authzAudit: "SELECT * FROM authorization_audit ORDER BY id",
};

const J = (v) => JSON.stringify(v == null ? [] : v);

class AuthorizationStore {
  /** @param opts.identity 已 open 的 IdentityStore（共享同一连接与事务队列）。 */
  constructor({ identity, clock } = {}) {
    if (!identity) throw new Error("AuthorizationStore 需要 IdentityStore");
    this.identity = identity;
    this.db = identity.connection;
    this.clock = typeof clock === "function" ? clock : identity.clock;
  }

  // -------------------------------------------------------------------------
  // 基础
  // -------------------------------------------------------------------------

  /** 授权写操作走**同一条**连接内事务队列，和身份写操作互斥且原子。 */
  transact(fn) {
    return this.identity.transact(fn);
  }

  transactSync(fn) {
    return this.identity.transactSync(fn);
  }

  // -------------------------------------------------------------------------
  // Department
  // -------------------------------------------------------------------------

  insertDepartment({ organizationId, name, description = "", createdBy = null, departmentId = null } = {}) {
    const id = departmentId || newId("DEPARTMENT");
    const now = this.clock();
    this.db.prepare(SQL.insertDepartment).run(id, String(organizationId), String(name), String(description), "ACTIVE", createdBy, now, now);
    return this.departmentById(id);
  }

  departmentById(id) {
    return this.db.prepare(SQL.departmentById).get(String(id || "")) || null;
  }

  departmentsOfOrg(organizationId) {
    return this.db.prepare(SQL.departmentsOfOrg).all(String(organizationId || ""));
  }

  updateDepartment(id, { name, description, status } = {}) {
    const current = this.departmentById(id);
    if (!current) return null;
    this.db
      .prepare(SQL.updateDepartment)
      .run(
        name == null ? current.name : String(name),
        description == null ? current.description : String(description),
        status == null ? current.status : String(status),
        this.clock(),
        current.id,
      );
    return this.departmentById(id);
  }

  // -------------------------------------------------------------------------
  // Department Membership
  // -------------------------------------------------------------------------

  upsertMembership({ departmentId, organizationId, userId, membershipRole = "member", status = "ACTIVE" } = {}) {
    const existing = this.db.prepare(SQL.membershipByPair).get(String(departmentId), String(userId)) || null;
    const now = this.clock();
    this.db
      .prepare(SQL.upsertMembership)
      .run(
        existing?.id || newId("MEMBERSHIP"),
        String(departmentId),
        String(organizationId),
        String(userId),
        String(membershipRole),
        String(status),
        existing?.created_at ?? now,
        now,
      );
    return this.db.prepare(SQL.membershipByPair).get(String(departmentId), String(userId));
  }

  membershipByPair(departmentId, userId) {
    return this.db.prepare(SQL.membershipByPair).get(String(departmentId), String(userId)) || null;
  }

  membershipsOfUser(userId) {
    return this.db.prepare(SQL.membershipsOfUser).all(String(userId || ""));
  }

  membershipsOfDepartment(departmentId) {
    return this.db.prepare(SQL.membershipsOfDepartment).all(String(departmentId || ""));
  }

  setMembershipStatus(departmentId, userId, status) {
    const res = this.db.prepare(SQL.setMembershipStatus).run(String(status), this.clock(), String(departmentId), String(userId));
    return { changed: res.changes > 0 };
  }

  removeMembership(departmentId, userId) {
    const res = this.db.prepare(SQL.deleteMembership).run(String(departmentId), String(userId));
    return { changed: res.changes > 0 };
  }

  // -------------------------------------------------------------------------
  // Collection
  // -------------------------------------------------------------------------

  insertCollection({ organizationId, departmentId = null, ownerUserId = null, name, description = "", scope = SCOPE.DEPARTMENT, collectionId = null } = {}) {
    const id = collectionId || newId("COLLECTION");
    const now = this.clock();
    this.db
      .prepare(SQL.insertCollection)
      .run(id, String(organizationId), departmentId, ownerUserId, String(name), String(description), String(scope), "active", now, now);
    return this.collectionById(id);
  }

  collectionById(id) {
    return this.db.prepare(SQL.collectionById).get(String(id || "")) || null;
  }

  collectionsOfOrg(organizationId) {
    return this.db.prepare(SQL.collectionsOfOrg).all(String(organizationId || ""));
  }

  /** D3-04B：Collection metadata 更新（不触碰 Resource）。 */
  updateCollection(id, { name, description } = {}) {
    const current = this.collectionById(id);
    if (!current) return { changed: false };
    const res = this.db
      .prepare(SQL.updateCollection)
      .run(name == null ? current.name : String(name), description == null ? current.description : String(description), this.clock(), String(id));
    return { changed: res.changes > 0, collection: this.collectionById(id) };
  }

  /** 软删除 Collection：Resource 归属由 ResourceService 重分配为 Unfiled，绝不级联删除。 */
  setCollectionStatus(id, status) {
    const res = this.db.prepare(SQL.setCollectionStatus).run(String(status), this.clock(), String(id));
    return { changed: res.changes > 0 };
  }

  // -------------------------------------------------------------------------
  // Resource Registry
  // -------------------------------------------------------------------------

  insertResource({
    resourceType,
    ownerUserId = null,
    organizationId,
    departmentId = null,
    collectionId = null,
    scope = SCOPE.PERSONAL,
    parentResourceId = null,
    name = "",
    description = "",
    tags = [],
    status = "active",
    resourceId = null,
  } = {}) {
    const check = domain.validateResourceType(resourceType);
    if (!check.ok) return null;
    const scopeCheck = domain.validateScope(scope);
    if (!scopeCheck.ok) return null;
    const id = resourceId || newId("RESOURCE");
    const now = this.clock();
    this.db
      .prepare(SQL.insertResource)
      .run(id, String(resourceType), ownerUserId, String(organizationId), departmentId, collectionId, String(scope), parentResourceId, String(name), String(description), J(tags), 1, String(status), now, now);
    return this.resourceById(id);
  }

  resourceById(id) {
    return this.db.prepare(SQL.resourceById).get(String(id || "")) || null;
  }

  /** 授权只认 resourceId；ref 只是投影。 */
  resourceByRef(ref) {
    const id = domain.parseResourceRef(ref);
    return id ? this.resourceById(id) : null;
  }

  setResourceStatus(resourceId, status) {
    const res = this.db.prepare(SQL.setResourceStatus).run(String(status), this.clock(), String(resourceId));
    this.deleteGrantsForResource(resourceId);
    return { changed: res.changes > 0 };
  }

  setResourceOwner(resourceId, ownerUserId) {
    const res = this.db.prepare(SQL.setResourceOwner).run(ownerUserId, this.clock(), String(resourceId));
    return { changed: res.changes > 0 };
  }

  /** Department A → Department B：旧 department inherited permission 必须消失。 */
  reparentResource(resourceId, { departmentId, organizationId, scope, collectionId = null }) {
    const res = this.db
      .prepare(SQL.reparentResource)
      .run(departmentId, organizationId, scope, collectionId, this.clock(), String(resourceId));
    return { changed: res.changes > 0 };
  }

  listRegistry(organizationId) {
    return this.db.prepare(SQL.listRegistryByOrg).all(String(organizationId || ""));
  }

  searchRegistry(organizationId, query) {
    const q = String(query || "");
    const like = "%" + q + "%";
    return this.db.prepare(SQL.searchRegistry).all(String(organizationId || ""), like, like, like);
  }

  // -------------------------------------------------------------------------
  // Resource Grants
  // -------------------------------------------------------------------------

  /**
   * ADDITIVE ALLOW：重复 grant 同一 principal/target 时**并集**动作，
   * 而不是替换。唯一约束保证只有一行，并集保证已授予的动作不会被一次
   * 不完整的 grant 意外收回（§20 §50）。
   */
  upsertResourceGrant({ principalType, principalId, resourceId = "", collectionId = "", resourceType = "", departmentId = "", scope = "", actions, permissionSet = null, grantedBy = null, organizationId, grantId = null } = {}) {
    const existing = this.resourceGrantByKey({ principalType, principalId, resourceId, collectionId, resourceType, departmentId, scope });
    const merged = [...new Set([...(existing ? domain.grantActions(existing) : []), ...(actions || [])])];
    const id = existing?.id || grantId || newId("GRANT");
    const now = this.clock();
    this.db
      .prepare(SQL.upsertResourceGrant)
      .run(id, String(principalType), String(principalId), String(resourceId), String(collectionId), String(resourceType), String(departmentId), String(scope), J(merged), permissionSet, grantedBy, String(organizationId), existing?.created_at ?? now, now);
    return { grant: this.resourceGrantById(id), created: !existing, previous: existing || null };
  }

  resourceGrantById(id) {
    return this.db.prepare(SQL.resourceGrantById).get(String(id || "")) || null;
  }

  resourceGrantByKey({ principalType, principalId, resourceId = "", collectionId = "", resourceType = "", departmentId = "", scope = "" } = {}) {
    return (
      this.db
        .prepare(SQL.resourceGrantByKey)
        .get(String(principalType), String(principalId), String(resourceId), String(collectionId), String(resourceType), String(departmentId), String(scope)) || null
    );
  }

  /** 一次取回某组织内的全部 grants，交给纯策略函数做匹配（服务层授权边界）。 */
  grantsForOrganizationContext(organizationId) {
    return this.db.prepare(SQL.grantsForPrincipals).all(String(organizationId || ""));
  }

  grantsForResource(resourceId) {
    return this.db.prepare(SQL.grantsForResource).all(String(resourceId || ""));
  }

  revokeResourceGrant(grantId) {
    const before = this.resourceGrantById(grantId);
    if (!before) return { changed: false, grant: null, previous: null };
    const res = this.db.prepare(SQL.deleteResourceGrant).run(String(grantId));
    return { changed: res.changes > 0, grant: null, previous: before };
  }

  /**
   * Reparent 时删除旧 Department inherited grant。
   * 显式 USER grant 保留（第一版规则，见 ADR）；App grant 由治理层另行处理。
   */
  deleteDepartmentGrantsForResource(resourceId, collectionId) {
    const res = this.db.prepare(SQL.deleteDepartmentGrantsForResource).run(String(resourceId || ""), String(collectionId || ""));
    return { changed: res.changes > 0 };
  }

  /** Resource 永久删除 / 转 scope 时清理其 grant，避免悬挂授权。 */
  deleteGrantsForResource(resourceId) {
    const res = this.db.prepare(SQL.deleteGrantsForResource).run(String(resourceId || ""), String(resourceId || ""));
    return { changed: res.changes > 0 };
  }

  // -------------------------------------------------------------------------
  // App Principal / App Grants
  // -------------------------------------------------------------------------

  upsertApp({ appId, name, publisher = "openarc-builtin", status = "enabled", builtIn = 1 } = {}) {
    const now = this.clock();
    this.db.prepare(SQL.upsertApp).run(String(appId), String(name || appId), String(publisher), String(status), builtIn ? 1 : 0, now, now);
    return this.appById(appId);
  }

  appById(appId) {
    return this.db.prepare(SQL.appById).get(String(appId || "")) || null;
  }

  allApps() {
    return this.db.prepare(SQL.allApps).all();
  }

  setAppStatus(appId, status) {
    const res = this.db.prepare(SQL.setAppStatus).run(String(status), this.clock(), String(appId));
    return { changed: res.changes > 0 };
  }

  upsertAppGrant({ appId, resourceId = "", collectionId = "", resourceType = "", departmentId = "", scope = "", actions, grantedBy = null, organizationId, expiresAt = null, grantId = null } = {}) {
    const existing = this.appGrantByKey({ appId, resourceId, collectionId, resourceType, departmentId, scope });
    const id = existing?.id || grantId || newId("GRANT");
    this.db
      .prepare(SQL.upsertAppGrant)
      .run(id, String(appId), String(resourceId), String(collectionId), String(resourceType), String(departmentId), String(scope), J(actions), grantedBy, String(organizationId), this.clock(), expiresAt);
    return { grant: this.appGrantById(id), created: !existing, previous: existing || null };
  }

  appGrantById(id) {
    return this.db.prepare(SQL.appGrantById).get(String(id || "")) || null;
  }

  appGrantByKey({ appId, resourceId = "", collectionId = "", resourceType = "", departmentId = "", scope = "" } = {}) {
    const row = this.db
      .prepare(
        "SELECT * FROM app_resource_grants WHERE app_id = ? AND resource_id = ? AND collection_id = ? AND resource_type = ? AND department_id = ? AND scope = ?",
      )
      .get(String(appId), String(resourceId), String(collectionId), String(resourceType), String(departmentId), String(scope));
    return row || null;
  }

  appGrantsForApp(appId) {
    return this.db.prepare(SQL.appGrantsForApp).all(String(appId || ""));
  }

  allAppGrants() {
    return this.db.prepare(SQL.allAppGrants).all();
  }

  /** 永久删除资源时清理其 App Grant（§44）；与 deleteGrantsForResource 成对使用。 */
  deleteAppGrantsForResource(resourceId) {
    const res = this.db.prepare(SQL.deleteAppGrantsForResource).run(String(resourceId || ""), String(resourceId || ""));
    return { changed: res.changes > 0 };
  }

  revokeAppGrant(grantId) {
    const before = this.appGrantById(grantId);
    if (!before) return { changed: false, grant: null, previous: null };
    const res = this.db.prepare(SQL.deleteAppGrant).run(String(grantId));
    return { changed: res.changes > 0, grant: null, previous: before };
  }

  // -------------------------------------------------------------------------
  // Authorization Audit（§57 / §58）
  // -------------------------------------------------------------------------

  auditAuthorization({
    actorUserId = null,
    targetUserId = null,
    appId = null,
    departmentId = null,
    resourceRef = null,
    action,
    decision,
    reasonCode = null,
    permissionSource = null,
    requestId = null,
    oldPermissions = null,
    newPermissions = null,
  } = {}) {
    const row = {
      at: this.clock(),
      actor_user_id: actorUserId,
      target_user_id: targetUserId,
      app_id: appId,
      department_id: departmentId,
      resource_ref: resourceRef ? domain.toResourceRef(resourceRef) || String(resourceRef) : null,
      action: String(action),
      decision: String(decision),
      reason_code: reasonCode,
      permission_source: permissionSource ? String(permissionSource) : null,
      request_id: requestId,
      old_permissions: oldPermissions ? J(oldPermissions) : null,
      new_permissions: newPermissions ? J(newPermissions) : null,
    };
    try {
      this.db
        .prepare(SQL.insertAuthzAudit)
        .run(
          row.at,
          row.actor_user_id,
          row.target_user_id,
          row.app_id,
          row.department_id,
          row.resource_ref,
          row.action,
          row.decision,
          row.reason_code,
          row.permission_source,
          row.request_id,
          row.old_permissions,
          row.new_permissions,
        );
    } catch {
      /* 审计失败不该让授权决策失败；但它本身要能被探针看见 */
    }
    return row;
  }

  authorizationAudit() {
    return this.db.prepare(SQL.authzAudit).all();
  }
}

module.exports = { AuthorizationStore, SQL };
