/**
 * D3-02 · Authorization Service —— 唯一对象授权权威。
 *
 * 所有 UI / Resource Library / File Manager / Canvas / Global Search / Agent /
 * Harness / MCP / Skill / App / Adobe 都必须复用本服务的 authorize()，
 * **不得**在各自的业务代码里判断 role 或自己拼 ACL。
 *
 * 授权链（冻结）：
 *   Session Gate → App Principal → Resource Registry → User Authorization
 *   → App Authorization → Scope / Department → Action → Agent useByAgent
 *
 * 默认 DEFAULT DENY + ADDITIVE ALLOW；source 只进 Audit，不参与提权。
 */
"use strict";

const domain = require("./authorization-domain.cjs");
const {
  ACTION,
  APP_STATUS,
  DECISION,
  PRINCIPAL,
  REASON,
  RESOURCE_ACTIONS,
  SCOPE,
  ALLOW_SOURCE,
  POLICY_VERSION,
  CAPABILITY_ACTIONS,
  GOVERNANCE_ACTION,
  SUPER_ADMIN_ONLY,
  externalReason,
} = domain;

/** 身份错误码 → 授权 reasonCode。 */
const SESSION_REASON = Object.freeze({
  SESSION_REVOKED: REASON.SESSION_REVOKED,
  SESSION_EXPIRED: REASON.SESSION_EXPIRED,
  USER_DISABLED: REASON.USER_DISABLED,
  LOCKED: REASON.SESSION_LOCKED,
});

class AuthorizationService {
  /**
   * @param opts.identity    已 open 的 IdentityStore（session 闸门 + 用户真值）
   * @param opts.authStore   AuthorizationStore（与 identity 共享同一连接）
   * @param opts.logger      可选
   */
  constructor({ identity, authStore, logger } = {}) {
    if (!identity) throw new Error("AuthorizationService 需要 IdentityStore");
    if (!authStore) throw new Error("AuthorizationService 需要 AuthorizationStore");
    this.identity = identity;
    this.store = authStore;
    this.logger = logger || null;
  }

  // -------------------------------------------------------------------------
  // 会话闸门（§30）
  // -------------------------------------------------------------------------

  /**
   * 所有 authorize 首先进入 D3-01 Session Validation。
   *
   * **userId / organizationId 一律来自 Session，不信 Renderer 输入**（§35）：
   * 渲染进程可以随便说自己是谁、属于哪个 team，主进程只认 session 反查出的 user。
   */
  #sessionGate(context) {
    const sessionRef = context?.sessionRef ? String(context.sessionRef) : null;
    if (!sessionRef) return { ok: false, reason: REASON.SESSION_REVOKED, challenge: "REAUTH" };
    const res = this.identity.validateSession(sessionRef, { sensitive: true });
    if (!res.ok) {
      const reason = SESSION_REASON[res.error] || REASON.SESSION_REVOKED;
      return { ok: false, reason, challenge: res.error === "LOCKED" ? "REAUTH" : null };
    }
    const user = res.user;
    const claimed = context?.userId ? String(context.userId) : null;
    if (claimed && claimed !== user.id) {
      return { ok: false, reason: REASON.SESSION_USER_MISMATCH, challenge: null };
    }
    return { ok: true, user, session: res.session };
  }

  #normalizeApplication(application) {
    if (!application) return null;
    if (typeof application === "string") return { appId: application };
    const appId = application.appId ? String(application.appId) : null;
    return appId ? { appId } : null;
  }

  /**
   * 预检：session + app principal + 该用户/组织的 grant 集合。
   * 一次 authorize 只做一次闸门与一次取数；getCapabilities 复用同一份 prepared。
   */
  #prepare(context, application) {
    const ctx = domain.normalizeContext(context);
    const gate = this.#sessionGate(ctx);
    if (!gate.ok) return { ok: false, reason: gate.reason, challenge: gate.challenge, ctx };
    const user = gate.user;
    // App 身份来自 Application Context / appId；缺省视为未声明 —— 默认 DENY。
    const app = this.#normalizeApplication(application) || (ctx.appId ? { appId: ctx.appId } : null);
    if (!app) return { ok: false, reason: REASON.APP_REQUIRED, ctx };
    const appRow = this.store.appById(app.appId);
    if (!appRow) return { ok: false, reason: REASON.APP_UNKNOWN, ctx, user, app };
    if (String(appRow.status).toLowerCase() !== APP_STATUS.ENABLED) {
      return { ok: false, reason: REASON.APP_DISABLED, ctx, user, app, appRow };
    }
    const memberships = this.store.membershipsOfUser(user.id).filter((m) => m.status === "ACTIVE");
    const grants = this.store.grantsForOrganizationContext(user.team_id);
    const appGrants = this.store.appGrantsForApp(app.appId);
    return {
      ok: true,
      ctx,
      user,
      organizationId: user.team_id,
      app: appRow,
      memberships,
      grants,
      appGrants,
      agent: !!ctx.agent,
      requestId: ctx.requestId,
      source: ctx.source,
    };
  }

  /** 纯策略求值 + 统一结果封装。 */
  #decide(prepared, resource, action, { agent, allowInactiveResource = false } = {}) {
    if (!prepared.ok) {
      return {
        decision: DECISION.DENY,
        reasonCode: prepared.reason,
        effectivePermissions: [],
        userActions: [],
        appActions: [],
        allowSources: [],
        challenge: prepared.challenge || null,
      };
    }
    if (!resource) {
      return {
        decision: DECISION.DENY,
        reasonCode: REASON.NOT_FOUND_OR_FORBIDDEN,
        effectivePermissions: [],
        userActions: [],
        appActions: [],
        allowSources: [],
      };
    }
    const policy = domain.evaluatePolicy({
      resource,
      user: prepared.user,
      memberships: prepared.memberships,
      grants: prepared.grants,
      app: prepared.app,
      appGrants: prepared.appGrants,
      action,
      agent: agent === undefined ? prepared.agent : !!agent,
      allowInactiveResource: !!allowInactiveResource,
    });
    return policy;
  }

  #resourceFromInput(input) {
    if (!input) return null;
    if (typeof input === "string") return this.store.resourceByRef(input);
    const id = input.resourceId || domain.parseResourceRef(input.resourceRef || input.ref || "");
    return id ? this.store.resourceById(id) : null;
  }

  #audit({ prepared, resource, action, decision, reasonCode, allowSources, oldPermissions, newPermissions, targetUserId, departmentId }) {
    const actor = prepared?.user?.id ?? null;
    this.store.auditAuthorization({
      actorUserId: actor,
      targetUserId: targetUserId ?? null,
      appId: prepared?.app?.app_id ?? null,
      departmentId: departmentId ?? null,
      resourceRef: resource?.resource_id ?? null,
      action,
      decision,
      reasonCode,
      permissionSource: (allowSources || []).join(",") || reasonCode,
      requestId: prepared?.requestId ?? null,
      oldPermissions,
      newPermissions,
    });
  }

  // -------------------------------------------------------------------------
  // authorize()（§29）
  // -------------------------------------------------------------------------

  /**
   * @returns decision / reasonCode / effectivePermissions / policyVersion
   */
  authorize({ actor, application, action, resource, context, allowInactiveResource = false } = {}) {
    const act = String(action || "");
    const prepared = this.#prepare(context, application || actor?.application);
    const base = {
      policyVersion: POLICY_VERSION,
      action: act,
      appId: prepared.app?.app_id ?? this.#normalizeApplication(application)?.appId ?? null,
      userId: prepared.user?.id ?? null,
      requestId: prepared.requestId ?? null,
      source: prepared.source ?? domain.SOURCE.MANUAL,
      resourceRef: null,
      challenge: prepared.challenge || null,
    };
    if (!RESOURCE_ACTIONS.includes(act)) {
      const reasonCode = REASON.INVALID_INPUT;
      this.#audit({ prepared, resource: null, action: act, decision: DECISION.DENY, reasonCode });
      return { ...base, decision: DECISION.DENY, reasonCode, effectivePermissions: [], userActions: [], appActions: [], allowSources: [] };
    }
    const row = this.#resourceFromInput(resource);
    if (row) base.resourceRef = domain.toResourceRef(row.resource_id);
    const decision = this.#decide(prepared, row, act, { allowInactiveResource });
    if (!prepared.ok) {
      // 会话级拒绝也要留审计（不含任何 Resource metadata）
      this.#audit({ prepared, resource: null, action: act, decision: DECISION.DENY, reasonCode: decision.reasonCode });
      return { ...base, ...decision, resourceRef: base.resourceRef };
    }
    const allowSources = decision.allowSources || [];
    this.#audit({ prepared, resource: row, action: act, decision: decision.decision, reasonCode: decision.reasonCode, allowSources });
    return {
      ...base,
      decision: decision.decision,
      reasonCode: decision.reasonCode === "ALLOW" ? "ALLOW" : externalReason(decision.reasonCode),
      effectivePermissions: decision.effectivePermissions,
      userActions: decision.userActions,
      appActions: decision.appActions,
      allowSources,
    };
  }

  /**
   * D3-04A §23：创建必须先针对 **target container / scope** 授权，而不是拿一个
   * 还不存在的 resourceId 去 authorize。
   *
   *   · PERSONAL     → 显式 Personal Library Owner Policy（owner_user_id = 当前用户），
   *                     不是"没有 ACL 行 → allow"
   *   · DEPARTMENT   → 必须是该部门 ACTIVE 成员，且目标（scope / collection / type）有 create grant
   *   · ORGANIZATION → 需要显式 grant；Super Admin 走治理策略
   *
   * 仍然要求 App Authorization 同时成立（§26）：系统内置 App 也不例外。
   */
  authorizeCreate({ context, application, actor, scope, departmentId = null, collectionId = null, resourceType = "other", action = ACTION.CREATE, agent } = {}) {
    const prepared = this.#prepare(context, application || actor?.application);
    const target = {
      resource_id: null,
      resource_type: String(resourceType || "other"),
      owner_user_id: scope === SCOPE.PERSONAL ? prepared.user?.id ?? null : null,
      organization_id: prepared.user?.team_id ?? null,
      department_id: scope === SCOPE.DEPARTMENT ? departmentId : null,
      collection_id: collectionId || null,
      scope,
      status: "active",
    };
    const base = {
      policyVersion: POLICY_VERSION,
      action,
      appId: prepared.app?.app_id ?? null,
      userId: prepared.user?.id ?? null,
      requestId: prepared.requestId ?? null,
      source: prepared.source ?? domain.SOURCE.MANUAL,
      targetScope: scope,
      targetDepartmentId: departmentId || null,
      targetCollectionId: collectionId || null,
    };
    if (!RESOURCE_ACTIONS.includes(action)) {
      return { ...base, decision: DECISION.DENY, reasonCode: REASON.INVALID_INPUT, effectivePermissions: [], allowSources: [] };
    }
    if (!prepared.ok) {
      this.#audit({ prepared, resource: null, action, decision: DECISION.DENY, reasonCode: prepared.reason });
      return { ...base, decision: DECISION.DENY, reasonCode: domain.externalReason(prepared.reason), effectivePermissions: [], allowSources: [], challenge: prepared.challenge || null };
    }
    // Super Admin 的治理能力集中在 Policy 中表达：允许组织内创建，但仍必须过 App 授权。
    if (prepared.user.role === "ADMIN") {
      const appActions = new Set();
      for (const g of prepared.appGrants || []) {
        if (!domain.appGrantCoversResource(g, target)) continue;
        for (const a of domain.grantActions(g)) appActions.add(a);
      }
      const allowed = appActions.has(action);
      const source = allowed ? [ALLOW_SOURCE.SUPER_ADMIN, ALLOW_SOURCE.APP_GRANT] : [];
      this.#audit({ prepared, resource: null, action, decision: allowed ? DECISION.ALLOW : DECISION.DENY, reasonCode: allowed ? "ALLOW" : REASON.APP_ACTION_NOT_GRANTED, allowSources: source });
      return { ...base, decision: allowed ? DECISION.ALLOW : DECISION.DENY, reasonCode: allowed ? "ALLOW" : REASON.APP_ACTION_NOT_GRANTED, effectivePermissions: [...appActions].sort(), allowSources: source };
    }
    const policy = this.#decide(prepared, target, action, { agent, allowInactiveResource: true });
    const reasonCode = policy.decision === DECISION.ALLOW ? "ALLOW" : domain.externalReason(policy.reasonCode);
    this.#audit({ prepared, resource: null, action, decision: policy.decision, reasonCode, allowSources: policy.allowSources || [] });
    return { ...base, ...policy, reasonCode };
  }

  /**
   * D3-04B Inspector：分别给出 User 侧 / App 侧 / 有效交集的能力集合。
   * 与 getCapabilities 不同，这里**即使当前离线也返回两侧集合**，用于权限说明展示。
   */
  getCapabilityBreakdown({ context, application, resource, agent } = {}) {
    const prepared = this.#prepare(context, application);
    if (!prepared.ok) return { ok: false, error: domain.externalReason(prepared.reason), challenge: prepared.challenge || null };
    const row = this.#resourceFromInput(resource);
    if (!row) return { ok: false, error: REASON.NOT_FOUND_OR_FORBIDDEN };
    const userResult = domain.evaluateUserAuthorization({ resource: row, user: prepared.user, memberships: prepared.memberships, grants: prepared.grants });
    const appResult = domain.evaluateAppAuthorization({ resource: row, app: prepared.app, grants: prepared.appGrants });
    const effective = [...userResult.actions].filter((a) => appResult.actions.has(a));
    return {
      ok: true,
      policyVersion: POLICY_VERSION,
      resourceRef: domain.toResourceRef(row.resource_id),
      userActions: [...userResult.actions].sort(),
      appActions: [...appResult.actions].sort(),
      effectivePermissions: effective.sort(),
      agent: agent === undefined ? prepared.agent : !!agent,
      userDenied: userResult.denied ? domain.externalReason(userResult.denied) : null,
      appDenied: appResult.denied || null,
    };
  }

  // -------------------------------------------------------------------------
  // getCapabilities()（§61）
  // -------------------------------------------------------------------------

  /**
   * UI projection：canRead / canEdit / ... 只用于画界面。
   * 最终 command 必须重新 authorize(action)，不能把这里的 true 当授权凭据。
   */
  getCapabilities({ actor, application, resource, context, agent, allowInactiveResource = false } = {}) {
    const prepared = this.#prepare(context, application || actor?.application);
    if (!prepared.ok) {
      return { ok: false, error: externalReason(prepared.reason), challenge: prepared.challenge || null, policyVersion: POLICY_VERSION };
    }
    const row = this.#resourceFromInput(resource);
    if (!row) return { ok: false, error: REASON.NOT_FOUND_OR_FORBIDDEN, policyVersion: POLICY_VERSION };
    const useAgent = agent === undefined ? prepared.agent : !!agent;
    const capabilities = {};
    const allowedActions = [];
    let viewReason = null;
    for (const [key, act] of Object.entries(CAPABILITY_ACTIONS)) {
      const d = this.#decide(prepared, row, act, { agent: useAgent, allowInactiveResource });
      capabilities[key] = d.decision === DECISION.ALLOW;
      if (capabilities[key]) allowedActions.push(act);
      if (act === ACTION.VIEW) viewReason = d.reasonCode;
    }
    const authorized = capabilities.canView || capabilities.canRead;
    // 对外收敛为 NOT_FOUND_OR_FORBIDDEN；**内部 Audit 记录真实原因**（§38）。
    this.#audit({
      prepared,
      resource: row,
      action: ACTION.VIEW,
      decision: authorized ? DECISION.ALLOW : DECISION.DENY,
      reasonCode: authorized ? "ALLOW" : viewReason || REASON.NOT_FOUND_OR_FORBIDDEN,
    });
    if (!authorized) return { ok: false, error: REASON.NOT_FOUND_OR_FORBIDDEN, policyVersion: POLICY_VERSION };
    return {
      ok: true,
      policyVersion: POLICY_VERSION,
      resourceRef: domain.toResourceRef(row.resource_id),
      resource: this.#safeMetadata(row),
      capabilities,
      allowedActions,
    };
  }

  #safeMetadata(row) {
    if (!row) return null;
    let tags = [];
    try {
      tags = JSON.parse(row.tags || "[]");
    } catch {
      tags = [];
    }
    return {
      resourceId: row.resource_id,
      resourceRef: domain.toResourceRef(row.resource_id),
      resourceType: row.resource_type,
      name: row.name,
      description: row.description,
      tags,
      scope: row.scope,
      departmentId: row.department_id ?? null,
      collectionId: row.collection_id ?? null,
      ownerUserId: row.owner_user_id ?? null,
      version: row.version,
      updatedAt: row.updated_at,
    };
  }

  // -------------------------------------------------------------------------
  // 枚举保护（§38 / §39）
  // -------------------------------------------------------------------------

  /**
   * 无权用户猜 resourceId：对外只能是 NOT_FOUND_OR_FORBIDDEN，
   * **不泄漏** name / owner / path / description / thumbnail / tag / collection / size。
   */
  getResource({ actor, application, resource, context } = {}) {
    const cap = this.getCapabilities({ actor, application, resource, context });
    if (!cap.ok) return cap;
    return { ok: true, policyVersion: POLICY_VERSION, resource: cap.resource, capabilities: cap.capabilities };
  }

  resolveResourceRef({ actor, application, resource, context } = {}) {
    const cap = this.getCapabilities({ actor, application, resource, context });
    if (!cap.ok) return cap;
    return { ok: true, policyVersion: POLICY_VERSION, resourceRef: cap.resourceRef };
  }

  // -------------------------------------------------------------------------
  // 查询过滤（§36 / §37 / §73）
  // -------------------------------------------------------------------------

  /**
   * 服务端授权过滤：候选集由 Registry 给出，但**只有通过 authorize 的**才会返回。
   * 禁止 SELECT all → Renderer/Agent → 再过滤。
   */
  listAuthorizedResources({ actor, application, action = ACTION.VIEW, context, filter = {} } = {}) {
    const prepared = this.#prepare(context, application || actor?.application);
    if (!prepared.ok) return { ok: false, error: externalReason(prepared.reason), items: [], count: 0 };
    const candidates = this.store.listRegistry(prepared.organizationId);
    const items = this.#filterAuthorized(prepared, candidates, action, filter);
    return { ok: true, policyVersion: POLICY_VERSION, items, count: items.length };
  }

  searchAuthorizedResources({ actor, application, query = "", action = ACTION.SEARCH, context, filter = {} } = {}) {
    const prepared = this.#prepare(context, application || actor?.application);
    if (!prepared.ok) return { ok: false, error: externalReason(prepared.reason), items: [], count: 0 };
    const candidates = this.store.searchRegistry(prepared.organizationId, query);
    const items = this.#filterAuthorized(prepared, candidates, action, filter);
    return { ok: true, policyVersion: POLICY_VERSION, items, count: items.length };
  }

  #filterAuthorized(prepared, candidates, action, filter = {}) {
    const out = [];
    for (const row of candidates) {
      if (filter.resourceType && row.resource_type !== filter.resourceType) continue;
      if (filter.scope && row.scope !== filter.scope) continue;
      if (filter.departmentId && row.department_id !== filter.departmentId) continue;
      if (filter.collectionId && row.collection_id !== filter.collectionId) continue;
      if (filter.status && row.status !== filter.status) continue;
      const d = this.#decide(prepared, row, action);
      if (d.decision === DECISION.ALLOW) out.push(this.#safeMetadata(row));
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Notification 重新授权（§63）
  // -------------------------------------------------------------------------

  /**
   * Notification 不得永久内嵌敏感 Resource Title 后无条件显示。
   * 使用 ResourceRef，显示前重新 authorize；撤销后只给通用提示，不泄漏 metadata。
   */
  notificationReauthorize({ actor, application, resource, context } = {}) {
    const cap = this.getCapabilities({ actor, application, resource, context });
    if (!cap.ok) {
      return {
        available: false,
        resourceRef: null,
        message: "内容不可用：你已无权访问此资源。",
        error: REASON.NOT_FOUND_OR_FORBIDDEN,
      };
    }
    return { available: true, resourceRef: cap.resourceRef, resource: cap.resource, message: null };
  }

  // -------------------------------------------------------------------------
  // Governance 闸门
  // -------------------------------------------------------------------------

  #governanceGate(context, action) {
    const appId = context?.appId || "resource-library";
    let prepared = this.#prepare(context, { appId });
    // 治理动作的授权主体是 User role，不是调用方 App 的资源权限。
    // 若调用方 App 正好处于 disabled（例如资源库 App 被停用后要重新启用），
    // 仍必须允许 Super Admin 管理 —— 否则会"禁用后无法再启用"。资源操作仍严格要求 App enabled。
    if (!prepared.ok && prepared.reason === REASON.APP_DISABLED && prepared.user) {
      prepared = {
        ...prepared,
        ok: true,
        memberships: this.store.membershipsOfUser(prepared.user.id).filter((m) => m.status === "ACTIVE"),
        organizationId: prepared.user.team_id,
        appDisabled: true,
      };
    }
    if (!prepared.ok) return { ok: false, error: externalReason(prepared.reason), challenge: prepared.challenge, prepared, status: 401 };
    const user = prepared.user;
    const isSuper = user.role === "ADMIN";
    const adminDeptIds = prepared.memberships
      .filter((m) => m.membership_role === domain.MEMBERSHIP_ROLE.DEPARTMENT_ADMIN)
      .map((m) => m.department_id);
    if (SUPER_ADMIN_ONLY.includes(action) && !isSuper) {
      return { ok: false, error: REASON.NOT_SUPER_ADMIN, prepared, status: 403, isSuper, adminDeptIds };
    }
    // Department Admin 只能走"本部门"路径；他们被允许的治理动作在各自方法里再校验范围。
    if (!isSuper && adminDeptIds.length === 0) {
      return { ok: false, error: REASON.NOT_SUPER_ADMIN, prepared, status: 403, isSuper, adminDeptIds };
    }
    return { ok: true, prepared, isSuper, adminDeptIds, user, app: prepared.app, source: isSuper ? ALLOW_SOURCE.SUPER_ADMIN : ALLOW_SOURCE.DEPARTMENT_ADMIN };
  }

  #govAudit(gate, { action, decision, reasonCode, targetUserId = null, departmentId = null, resourceRef = null, oldPermissions = null, newPermissions = null }) {
    this.store.auditAuthorization({
      actorUserId: gate.prepared?.user?.id ?? null,
      targetUserId,
      appId: gate.prepared?.app?.app_id ?? null,
      departmentId,
      resourceRef,
      action,
      decision,
      reasonCode,
      permissionSource: gate.source || null,
      requestId: gate.prepared?.requestId ?? null,
      oldPermissions,
      newPermissions,
    });
  }

  // -------------------------------------------------------------------------
  // Department governance
  // -------------------------------------------------------------------------

  createDepartment({ context, name, description = "" } = {}) {
    const gate = this.#governanceGate(context, GOVERNANCE_ACTION.CREATE_DEPARTMENT);
    if (!gate.ok) return { ok: false, error: gate.error };
    const deptName = String(name || "").trim();
    if (!deptName) return { ok: false, error: REASON.INVALID_INPUT };
    try {
      const dept = this.store.transactSync(() =>
        this.store.insertDepartment({ organizationId: gate.user.team_id, name: deptName, description, createdBy: gate.user.id }),
      );
      this.#govAudit(gate, { action: GOVERNANCE_ACTION.CREATE_DEPARTMENT, decision: DECISION.ALLOW, reasonCode: "ALLOW", departmentId: dept.id, newPermissions: [] });
      return { ok: true, department: dept };
    } catch (e) {
      const dup = String(e?.message || "").includes("UNIQUE");
      this.#govAudit(gate, { action: GOVERNANCE_ACTION.CREATE_DEPARTMENT, decision: DECISION.DENY, reasonCode: dup ? REASON.INVALID_INPUT : REASON.INTERNAL_ERROR });
      return { ok: false, error: dup ? REASON.INVALID_INPUT : REASON.INTERNAL_ERROR };
    }
  }

  updateDepartment({ context, departmentId, name, description, status } = {}) {
    const gate = this.#governanceGate(context, GOVERNANCE_ACTION.UPDATE_DEPARTMENT);
    if (!gate.ok) return { ok: false, error: gate.error };
    const dept = this.store.departmentById(departmentId);
    if (!dept || dept.organization_id !== gate.user.team_id) return { ok: false, error: REASON.INVALID_INPUT };
    const updated = this.store.transactSync(() => this.store.updateDepartment(dept.id, { name, description, status }));
    this.#govAudit(gate, { action: GOVERNANCE_ACTION.UPDATE_DEPARTMENT, decision: DECISION.ALLOW, reasonCode: "ALLOW", departmentId: dept.id });
    return { ok: true, department: updated };
  }

  listDepartments({ context } = {}) {
    const gate = this.#governanceGate(context, GOVERNANCE_ACTION.VIEW_AUDIT);
    if (!gate.ok) return { ok: false, error: gate.error, items: [] };
    const items = this.store.departmentsOfOrg(gate.user.team_id);
    return { ok: true, items: gate.isSuper ? items : items.filter((d) => gate.adminDeptIds.includes(d.id)) };
  }

  // -------------------------------------------------------------------------
  // Membership governance
  // -------------------------------------------------------------------------

  addDepartmentMember({ context, departmentId, userId, membershipRole = "member" } = {}) {
    const gate = this.#governanceGate(context, GOVERNANCE_ACTION.MANAGE_DEPARTMENT_MEMBER);
    if (!gate.ok) return { ok: false, error: gate.error };
    const dept = this.store.departmentById(departmentId);
    if (!dept || dept.organization_id !== gate.user.team_id) return { ok: false, error: REASON.CROSS_DEPARTMENT_DENIED };
    // Department Admin：只能管理自己就是 admin 的部门，且不能给自己升级角色。
    if (!gate.isSuper && !gate.adminDeptIds.includes(dept.id)) return { ok: false, error: REASON.CROSS_DEPARTMENT_DENIED };
    const role = String(membershipRole || "member");
    if (![domain.MEMBERSHIP_ROLE.DEPARTMENT_ADMIN, domain.MEMBERSHIP_ROLE.MEMBER].includes(role)) {
      return { ok: false, error: REASON.INVALID_INPUT };
    }
    if (!gate.isSuper && String(userId) === gate.user.id && role === domain.MEMBERSHIP_ROLE.DEPARTMENT_ADMIN) {
      return { ok: false, error: REASON.SELF_ESCALATION_DENIED };
    }
    const target = this.identity.userById(userId);
    if (!target || target.team_id !== gate.user.team_id) return { ok: false, error: REASON.CROSS_DEPARTMENT_DENIED };
    const membership = this.store.transactSync(() =>
      this.store.upsertMembership({ departmentId: dept.id, organizationId: dept.organization_id, userId: target.id, membershipRole: role, status: "ACTIVE" }),
    );
    this.#govAudit(gate, { action: GOVERNANCE_ACTION.MANAGE_DEPARTMENT_MEMBER, decision: DECISION.ALLOW, reasonCode: "ALLOW", departmentId: dept.id, targetUserId: target.id, newPermissions: [role] });
    return { ok: true, membership };
  }

  removeDepartmentMember({ context, departmentId, userId } = {}) {
    const gate = this.#governanceGate(context, GOVERNANCE_ACTION.MANAGE_DEPARTMENT_MEMBER);
    if (!gate.ok) return { ok: false, error: gate.error };
    const dept = this.store.departmentById(departmentId);
    if (!dept || dept.organization_id !== gate.user.team_id) return { ok: false, error: REASON.CROSS_DEPARTMENT_DENIED };
    if (!gate.isSuper && !gate.adminDeptIds.includes(dept.id)) return { ok: false, error: REASON.CROSS_DEPARTMENT_DENIED };
    const before = this.store.membershipByPair(dept.id, userId);
    // Revoke 幂等：不存在也算成功，返回 NO_CHANGE。
    if (!before) {
      this.#govAudit(gate, { action: GOVERNANCE_ACTION.MANAGE_DEPARTMENT_MEMBER, decision: DECISION.ALLOW, reasonCode: REASON.NO_CHANGE, departmentId: dept.id, targetUserId: userId });
      return { ok: true, changed: false, reasonCode: REASON.NO_CHANGE };
    }
    this.store.transactSync(() => this.store.removeMembership(dept.id, userId));
    this.#govAudit(gate, { action: GOVERNANCE_ACTION.MANAGE_DEPARTMENT_MEMBER, decision: DECISION.ALLOW, reasonCode: "ALLOW", departmentId: dept.id, targetUserId: userId, oldPermissions: [before.membership_role], newPermissions: [] });
    return { ok: true, changed: true, reasonCode: "ALLOW" };
  }

  // -------------------------------------------------------------------------
  // User governance
  // -------------------------------------------------------------------------

  async createUser({ context, identifier, password, displayName, role = "MEMBER" } = {}) {
    const gate = this.#governanceGate(context, GOVERNANCE_ACTION.CREATE_USER);
    if (!gate.ok) return { ok: false, error: gate.error };
    const res = await this.identity.createUser({ identifier, password, displayName, role, teamId: gate.user.team_id });
    this.#govAudit(gate, {
      action: GOVERNANCE_ACTION.CREATE_USER,
      decision: res.ok ? DECISION.ALLOW : DECISION.DENY,
      reasonCode: res.ok ? "ALLOW" : res.error,
      targetUserId: res.userId ?? null,
      newPermissions: [String(role || "MEMBER")],
    });
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, userId: res.userId, identifier: res.identifier, role: res.role };
  }

  setUserStatus({ context, userId, status } = {}) {
    const gate = this.#governanceGate(context, GOVERNANCE_ACTION.SET_USER_STATUS);
    if (!gate.ok) return { ok: false, error: gate.error };
    const res = this.identity.setUserStatus(userId, status);
    this.#govAudit(gate, {
      action: GOVERNANCE_ACTION.SET_USER_STATUS,
      decision: res.ok ? DECISION.ALLOW : DECISION.DENY,
      reasonCode: res.ok ? "ALLOW" : res.error,
      targetUserId: userId,
      newPermissions: [String(status)],
    });
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, userId: res.user.id, status: res.user.status };
  }

  setUserRole({ context, userId, role } = {}) {
    const gate = this.#governanceGate(context, GOVERNANCE_ACTION.SET_USER_ROLE);
    if (!gate.ok) return { ok: false, error: gate.error };
    // 不允许给自己改成更高角色（自我提权）。
    if (String(userId) === gate.user.id && String(role).toUpperCase() === "ADMIN") {
      this.#govAudit(gate, { action: GOVERNANCE_ACTION.SET_USER_ROLE, decision: DECISION.DENY, reasonCode: REASON.SELF_ESCALATION_DENIED, targetUserId: userId });
      return { ok: false, error: REASON.SELF_ESCALATION_DENIED };
    }
    const before = this.identity.userById(userId);
    const res = this.identity.setUserRole(userId, role);
    this.#govAudit(gate, {
      action: GOVERNANCE_ACTION.SET_USER_ROLE,
      decision: res.ok ? DECISION.ALLOW : DECISION.DENY,
      reasonCode: res.ok ? "ALLOW" : res.error,
      targetUserId: userId,
      oldPermissions: before ? [before.role] : [],
      newPermissions: res.ok ? [res.user.role] : [],
    });
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, userId: res.user.id, role: res.user.role };
  }

  // -------------------------------------------------------------------------
  // Resource Registry governance / fixtures
  // -------------------------------------------------------------------------

  registerResource({ context, resourceId = null, resourceType, ownerUserId = null, organizationId = null, departmentId = null, collectionId = null, scope = SCOPE.PERSONAL, parentResourceId = null, name = "", description = "", tags = [], status = "active" } = {}) {
    const prepared = this.#prepare(context, context?.application || { appId: context?.appId || "resource-library" });
    if (!prepared.ok) return { ok: false, error: externalReason(prepared.reason) };
    const user = prepared.user;
    const targetOrg = user.team_id;
    const targetOwner = ownerUserId || user.id;
    const isSuper = user.role === "ADMIN";
    const adminDeptIds = prepared.memberships
      .filter((m) => m.membership_role === domain.MEMBERSHIP_ROLE.DEPARTMENT_ADMIN)
      .map((m) => m.department_id);
    if (scope === SCOPE.PERSONAL && targetOwner !== user.id && !isSuper) return { ok: false, error: REASON.CROSS_DEPARTMENT_DENIED };
    if (scope === SCOPE.DEPARTMENT) {
      if (!isSuper && !adminDeptIds.includes(departmentId)) return { ok: false, error: REASON.CROSS_DEPARTMENT_DENIED };
      const dept = this.store.departmentById(departmentId);
      if (!dept || dept.organization_id !== targetOrg) return { ok: false, error: REASON.CROSS_DEPARTMENT_DENIED };
    }
    if (scope === SCOPE.ORGANIZATION && !isSuper) return { ok: false, error: REASON.NOT_SUPER_ADMIN };
    if (scope !== SCOPE.DEPARTMENT && departmentId) {
      const dept = this.store.departmentById(departmentId);
      if (!dept || dept.organization_id !== targetOrg) return { ok: false, error: REASON.CROSS_DEPARTMENT_DENIED };
    }
    let row;
    try {
      row = this.store.transactSync(() =>
        this.store.insertResource({
          resourceId,
          resourceType,
          ownerUserId: targetOwner,
          organizationId: targetOrg,
          departmentId,
          collectionId,
          scope,
          parentResourceId,
          name,
          description,
          tags,
          status,
        }),
      );
    } catch {
      return { ok: false, error: REASON.INTERNAL_ERROR };
    }
    if (!row) return { ok: false, error: REASON.INVALID_INPUT };
    this.#audit({ prepared, resource: row, action: "resource.register", decision: DECISION.ALLOW, reasonCode: "ALLOW" });
    return { ok: true, resource: this.#safeMetadata(row) };
  }

  createCollection({ context, name, description = "", departmentId = null, scope = SCOPE.DEPARTMENT, ownerUserId = null } = {}) {
    const prepared = this.#prepare(context, context?.application || { appId: context?.appId || "resource-library" });
    if (!prepared.ok) return { ok: false, error: externalReason(prepared.reason) };
    const user = prepared.user;
    const isSuper = user.role === "ADMIN";
    const adminDeptIds = prepared.memberships
      .filter((m) => m.membership_role === domain.MEMBERSHIP_ROLE.DEPARTMENT_ADMIN)
      .map((m) => m.department_id);
    if (scope === SCOPE.DEPARTMENT && !isSuper && !adminDeptIds.includes(departmentId)) return { ok: false, error: REASON.CROSS_DEPARTMENT_DENIED };
    if (scope === SCOPE.ORGANIZATION && !isSuper) return { ok: false, error: REASON.NOT_SUPER_ADMIN };
    let row;
    try {
      row = this.store.transactSync(() =>
        this.store.insertCollection({ organizationId: user.team_id, departmentId, ownerUserId: ownerUserId || user.id, name, description, scope }),
      );
    } catch {
      return { ok: false, error: REASON.INTERNAL_ERROR };
    }
    this.#audit({ prepared, resource: null, action: "collection.create", decision: DECISION.ALLOW, reasonCode: "ALLOW", departmentId });
    return { ok: true, collection: row };
  }

  setResourceStatus({ context, resourceId, status } = {}) {
    const prepared = this.#prepare(context, context?.application || { appId: context?.appId || "resource-library" });
    if (!prepared.ok) return { ok: false, error: externalReason(prepared.reason) };
    const resource = this.store.resourceById(resourceId);
    if (!resource) return { ok: false, error: REASON.NOT_FOUND_OR_FORBIDDEN };
    const action = status === "deleted" && prepared.user.role === "ADMIN" ? ACTION.DELETE : ACTION.EDIT;
    const d = this.#decide(prepared, resource, action);
    if (d.decision !== DECISION.ALLOW) {
      this.#audit({ prepared, resource, action, decision: DECISION.DENY, reasonCode: d.reasonCode });
      return { ok: false, error: externalReason(d.reasonCode) };
    }
    this.store.transactSync(() => this.store.setResourceStatus(resourceId, status));
    this.#audit({ prepared, resource, action, decision: DECISION.ALLOW, reasonCode: "ALLOW" });
    return { ok: true, changed: true };
  }

  /**
   * Reparent：Department A → Department B。
   * 旧的 Department inherited grant 必须被移除；B 的 Policy 重新计算（§33）。
   */
  reparentResource({ context, resourceId, departmentId, collectionId = null } = {}) {
    const prepared = this.#prepare(context, context?.application || { appId: context?.appId || "resource-library" });
    if (!prepared.ok) return { ok: false, error: externalReason(prepared.reason) };
    const user = prepared.user;
    const isSuper = user.role === "ADMIN";
    const adminDeptIds = prepared.memberships
      .filter((m) => m.membership_role === domain.MEMBERSHIP_ROLE.DEPARTMENT_ADMIN)
      .map((m) => m.department_id);
    const dept = this.store.departmentById(departmentId);
    if (!dept || dept.organization_id !== user.team_id) return { ok: false, error: REASON.CROSS_DEPARTMENT_DENIED };
    if (!isSuper && !adminDeptIds.includes(dept.id)) return { ok: false, error: REASON.CROSS_DEPARTMENT_DENIED };
    const resource = this.store.resourceById(resourceId);
    if (!resource) return { ok: false, error: REASON.NOT_FOUND_OR_FORBIDDEN };
    if (!isSuper) {
      const d = this.#decide(prepared, resource, ACTION.MANAGE_ACCESS);
      if (d.decision !== DECISION.ALLOW) return { ok: false, error: externalReason(d.reasonCode) };
    }
    const oldCollectionId = resource.collection_id;
    this.store.transactSync(() => {
      this.store.reparentResource(resourceId, { departmentId: dept.id, organizationId: dept.organization_id, scope: SCOPE.DEPARTMENT, collectionId });
      this.store.deleteDepartmentGrantsForResource(resourceId, oldCollectionId);
    });
    this.#audit({ prepared, resource, action: "resource.reparent", decision: DECISION.ALLOW, reasonCode: "ALLOW", departmentId: dept.id, oldPermissions: [resource.department_id || ""], newPermissions: [dept.id] });
    return { ok: true, resource: this.#safeMetadata(this.store.resourceById(resourceId)) };
  }

  transferResourceOwnership({ context, resourceId, newOwnerUserId } = {}) {
    const gate = this.#governanceGate(context, GOVERNANCE_ACTION.TRANSFER_OWNERSHIP);
    if (!gate.ok) return { ok: false, error: gate.error };
    const resource = this.store.resourceById(resourceId);
    if (!resource) return { ok: false, error: REASON.NOT_FOUND_OR_FORBIDDEN };
    const target = this.identity.userById(newOwnerUserId);
    if (!target || target.team_id !== gate.user.team_id) return { ok: false, error: REASON.CROSS_DEPARTMENT_DENIED };
    this.store.transactSync(() => this.store.setResourceOwner(resourceId, target.id));
    this.#govAudit(gate, {
      action: GOVERNANCE_ACTION.TRANSFER_OWNERSHIP,
      decision: DECISION.ALLOW,
      reasonCode: "ALLOW",
      targetUserId: target.id,
      resourceRef: resource.resource_id,
      oldPermissions: [resource.owner_user_id || ""],
      newPermissions: [target.id],
    });
    return { ok: true, resource: this.#safeMetadata(this.store.resourceById(resourceId)) };
  }

  // -------------------------------------------------------------------------
  // Resource permission grants（§13 / §20 / §21）
  // -------------------------------------------------------------------------

  grantResourcePermission({ context, principalType, principalId, resourceId = null, collectionId = null, resourceType = null, departmentId = null, scope = null, actions = null, permissionSet = null } = {}) {
    const prepared = this.#prepare(context, context?.application || { appId: context?.appId || "resource-library" });
    if (!prepared.ok) return { ok: false, error: externalReason(prepared.reason) };
    const user = prepared.user;
    const isSuper = user.role === "ADMIN";
    const adminDeptIds = prepared.memberships
      .filter((m) => m.membership_role === domain.MEMBERSHIP_ROLE.DEPARTMENT_ADMIN)
      .map((m) => m.department_id);
    const normalized = domain.normalizeGrantActions({ actions, permissionSet });
    if (!normalized || !normalized.length) return { ok: false, error: REASON.INVALID_INPUT };
    const target = { resourceId: resourceId || "", collectionId: collectionId || "", resourceType: resourceType || "", departmentId: departmentId || "", scope: scope || "" };
    const hasTarget = Object.values(target).some((v) => v);
    if (!hasTarget) return { ok: false, error: REASON.INVALID_INPUT };

    // 目标 Resource 必须存在且在本组织，用于计算 grantor 的 ceiling。
    if (resourceId) {
      const resource = this.store.resourceById(resourceId);
      if (!resource || resource.organization_id !== user.team_id) return { ok: false, error: REASON.NOT_FOUND_OR_FORBIDDEN };
    }

    // 计算 grantor 的 ceiling：Super Admin 是组织级治理权威；其余按 User ∩ App 有效权限。
    let grantorActions;
    let grantorCanManage;
    if (isSuper) {
      grantorActions = [...RESOURCE_ACTIONS];
      grantorCanManage = true;
    } else {
      const resource = resourceId ? this.store.resourceById(resourceId) : null;
      const probeResource = resource || { resource_id: null, resource_type: resourceType || "other", owner_user_id: null, organization_id: user.team_id, department_id: departmentId || null, collection_id: collectionId || null, scope: scope || SCOPE.DEPARTMENT, status: "active" };
      const policy = domain.evaluatePolicy({
        resource: probeResource,
        user,
        memberships: prepared.memberships,
        grants: prepared.grants,
        app: prepared.app,
        appGrants: prepared.appGrants,
        action: ACTION.MANAGE_ACCESS,
      });
      grantorActions = policy.effectivePermissions;
      grantorCanManage = policy.effectivePermissions.includes(ACTION.MANAGE_ACCESS);
    }

    // 目标 principal 校验 + 跨部门边界
    if (principalType === PRINCIPAL.DEPARTMENT) {
      const dept = this.store.departmentById(principalId);
      if (!dept || dept.organization_id !== user.team_id) return { ok: false, error: REASON.CROSS_DEPARTMENT_DENIED };
      if (!isSuper && !adminDeptIds.includes(dept.id)) return { ok: false, error: REASON.CROSS_DEPARTMENT_DENIED };
      if (target.departmentId && target.departmentId !== dept.id && !isSuper) return { ok: false, error: REASON.CROSS_DEPARTMENT_DENIED };
    } else if (principalType === PRINCIPAL.USER) {
      const targetUser = this.identity.userById(principalId);
      if (!targetUser || targetUser.team_id !== user.team_id) return { ok: false, error: REASON.CROSS_DEPARTMENT_DENIED };
      if (!isSuper) {
        // 目标 Resource 所属部门（DEPARTMENT scope 时存在）。PERSONAL/ORGANIZATION 为 null。
        const scopedDept = target.departmentId || (resourceId ? this.store.resourceById(resourceId)?.department_id : null) || null;
        if (scopedDept) {
          const memberDeptIds = prepared.memberships.map((m) => m.department_id);
          // grantor 必须是该部门的成员（或被委托的部门管理员），且被授权者也要在该部门内。
          if (!adminDeptIds.includes(scopedDept) && !memberDeptIds.includes(scopedDept)) {
            return { ok: false, error: REASON.CROSS_DEPARTMENT_DENIED };
          }
          const targetMemberships = this.store.membershipsOfUser(targetUser.id).filter((m) => m.status === "ACTIVE");
          if (!targetMemberships.some((m) => m.department_id === scopedDept)) {
            return { ok: false, error: REASON.CROSS_DEPARTMENT_DENIED };
          }
        }
      }
    } else {
      return { ok: false, error: REASON.INVALID_INPUT };
    }

    // 自我提权检查（在 delegation 之前，语义更明确）
    const escalation = domain.evaluateSelfEscalation({
      grantorUserId: user.id,
      principalType,
      principalId,
      actionsBeingGranted: normalized,
      grantorActions,
    });
    if (!escalation.ok) {
      this.#govAudit({ prepared, source: isSuper ? ALLOW_SOURCE.SUPER_ADMIN : ALLOW_SOURCE.DEPARTMENT_ADMIN }, { action: GOVERNANCE_ACTION.GRANT_RESOURCE_PERMISSION, decision: DECISION.DENY, reasonCode: escalation.error, targetUserId: principalType === PRINCIPAL.USER ? principalId : null, resourceRef: resourceId });
      return { ok: false, error: escalation.error };
    }

    const delegation = domain.evaluateDelegation({ grantorActions, actionsBeingGranted: normalized, grantorCanManage });
    if (!delegation.ok) {
      this.#govAudit({ prepared, source: isSuper ? ALLOW_SOURCE.SUPER_ADMIN : ALLOW_SOURCE.DEPARTMENT_ADMIN }, { action: GOVERNANCE_ACTION.GRANT_RESOURCE_PERMISSION, decision: DECISION.DENY, reasonCode: delegation.error, targetUserId: principalType === PRINCIPAL.USER ? principalId : null, resourceRef: resourceId });
      return { ok: false, error: delegation.error, missing: delegation.missing };
    }

    let result;
    try {
      result = this.store.transactSync(() =>
        this.store.upsertResourceGrant({
          principalType,
          principalId,
          resourceId: target.resourceId,
          collectionId: target.collectionId,
          resourceType: target.resourceType,
          departmentId: target.departmentId,
          scope: target.scope,
          actions: normalized,
          permissionSet: permissionSet ? String(permissionSet).toUpperCase() : null,
          grantedBy: user.id,
          organizationId: user.team_id,
        }),
      );
    } catch {
      return { ok: false, error: REASON.INTERNAL_ERROR };
    }
    this.#govAudit(
      { prepared, source: isSuper ? ALLOW_SOURCE.SUPER_ADMIN : ALLOW_SOURCE.DEPARTMENT_ADMIN },
      {
        action: GOVERNANCE_ACTION.GRANT_RESOURCE_PERMISSION,
        decision: DECISION.ALLOW,
        reasonCode: "ALLOW",
        targetUserId: principalType === PRINCIPAL.USER ? principalId : null,
        departmentId: principalType === PRINCIPAL.DEPARTMENT ? principalId : target.departmentId || null,
        resourceRef: resourceId,
        oldPermissions: result.previous ? domain.grantActions(result.previous) : [],
        newPermissions: domain.grantActions(result.grant),
      },
    );
    return { ok: true, created: result.created, grant: result.grant };
  }

  revokeResourcePermission({ context, grantId } = {}) {
    const prepared = this.#prepare(context, context?.application || { appId: context?.appId || "resource-library" });
    if (!prepared.ok) return { ok: false, error: externalReason(prepared.reason) };
    const user = prepared.user;
    const isSuper = user.role === "ADMIN";
    const adminDeptIds = prepared.memberships
      .filter((m) => m.membership_role === domain.MEMBERSHIP_ROLE.DEPARTMENT_ADMIN)
      .map((m) => m.department_id);
    const grant = this.store.resourceGrantById(grantId);
    if (!grant) return { ok: true, changed: false, reasonCode: REASON.NO_CHANGE };
    if (!isSuper) {
      const scopedDept = grant.department_id || (grant.resource_id ? this.store.resourceById(grant.resource_id)?.department_id : null);
      if (!scopedDept || !adminDeptIds.includes(scopedDept)) return { ok: false, error: REASON.CROSS_DEPARTMENT_DENIED };
      if (grant.principal_type === PRINCIPAL.DEPARTMENT && grant.principal_id !== scopedDept && !adminDeptIds.includes(grant.principal_id)) {
        return { ok: false, error: REASON.CROSS_DEPARTMENT_DENIED };
      }
    }
    const res = this.store.transactSync(() => this.store.revokeResourceGrant(grantId));
    if (!res.changed) return { ok: true, changed: false, reasonCode: REASON.NO_CHANGE };
    this.#govAudit(
      { prepared, source: isSuper ? ALLOW_SOURCE.SUPER_ADMIN : ALLOW_SOURCE.DEPARTMENT_ADMIN },
      {
        action: GOVERNANCE_ACTION.REVOKE_RESOURCE_PERMISSION,
        decision: DECISION.ALLOW,
        reasonCode: "ALLOW",
        targetUserId: grant.principal_type === PRINCIPAL.USER ? grant.principal_id : null,
        departmentId: grant.department_id || null,
        resourceRef: grant.resource_id || null,
        oldPermissions: domain.grantActions(grant),
        newPermissions: [],
      },
    );
    return { ok: true, changed: true, reasonCode: "ALLOW" };
  }

  // -------------------------------------------------------------------------
  // App governance（§21–§23 / §47–§49）
  // -------------------------------------------------------------------------

  registerApp({ context, appId, name, publisher = "openarc-builtin", status = "enabled", builtIn = 0 } = {}) {
    const gate = this.#governanceGate(context, GOVERNANCE_ACTION.REGISTER_APP);
    if (!gate.ok) return { ok: false, error: gate.error };
    if (!appId) return { ok: false, error: REASON.INVALID_INPUT };
    const row = this.store.transactSync(() => this.store.upsertApp({ appId, name, publisher, status, builtIn }));
    this.#govAudit(gate, { action: GOVERNANCE_ACTION.REGISTER_APP, decision: DECISION.ALLOW, reasonCode: "ALLOW", newPermissions: [String(status)] });
    return { ok: true, app: row };
  }

  setAppStatus({ context, appId, status } = {}) {
    const gate = this.#governanceGate(context, GOVERNANCE_ACTION.SET_APP_STATUS);
    if (!gate.ok) return { ok: false, error: gate.error };
    const app = this.store.appById(appId);
    if (!app) return { ok: false, error: REASON.INVALID_INPUT };
    const normalized = String(status || "").toLowerCase();
    if (![APP_STATUS.ENABLED, APP_STATUS.DISABLED].includes(normalized)) return { ok: false, error: REASON.INVALID_INPUT };
    this.store.transactSync(() => this.store.setAppStatus(appId, normalized));
    this.#govAudit(gate, { action: GOVERNANCE_ACTION.SET_APP_STATUS, decision: DECISION.ALLOW, reasonCode: "ALLOW", targetUserId: null, oldPermissions: [app.status], newPermissions: [normalized] });
    return { ok: true, app: this.store.appById(appId) };
  }

  listApps({ context } = {}) {
    const gate = this.#governanceGate(context, GOVERNANCE_ACTION.VIEW_AUDIT);
    if (!gate.ok) return { ok: false, error: gate.error, items: [] };
    return { ok: true, items: this.store.allApps() };
  }

  grantAppResourcePermission({ context, appId, resourceId = null, collectionId = null, resourceType = null, departmentId = null, scope = null, actions = null, permissionSet = null, expiresAt = null } = {}) {
    const gate = this.#governanceGate(context, GOVERNANCE_ACTION.GRANT_APP_PERMISSION);
    if (!gate.ok) return { ok: false, error: gate.error };
    const app = this.store.appById(appId);
    if (!app) return { ok: false, error: REASON.APP_UNKNOWN };
    const normalized = domain.normalizeGrantActions({ actions, permissionSet });
    if (!normalized || !normalized.length) return { ok: false, error: REASON.INVALID_INPUT };
    if (resourceId) {
      const resource = this.store.resourceById(resourceId);
      if (!resource || resource.organization_id !== gate.user.team_id) return { ok: false, error: REASON.NOT_FOUND_OR_FORBIDDEN };
    }
    const result = this.store.transactSync(() =>
      this.store.upsertAppGrant({
        appId,
        resourceId: resourceId || "",
        collectionId: collectionId || "",
        resourceType: resourceType || "",
        departmentId: departmentId || "",
        scope: scope || "",
        actions: normalized,
        grantedBy: gate.user.id,
        organizationId: gate.user.team_id,
        expiresAt,
      }),
    );
    this.#govAudit(gate, {
      action: GOVERNANCE_ACTION.GRANT_APP_PERMISSION,
      decision: DECISION.ALLOW,
      reasonCode: "ALLOW",
      departmentId: departmentId || null,
      resourceRef: resourceId || null,
      oldPermissions: result.previous ? domain.grantActions(result.previous) : [],
      newPermissions: domain.grantActions(result.grant),
    });
    return { ok: true, created: result.created, grant: result.grant };
  }

  revokeAppResourcePermission({ context, grantId } = {}) {
    const gate = this.#governanceGate(context, GOVERNANCE_ACTION.REVOKE_APP_PERMISSION);
    if (!gate.ok) return { ok: false, error: gate.error };
    const before = this.store.appGrantById(grantId);
    if (!before) {
      this.#govAudit(gate, { action: GOVERNANCE_ACTION.REVOKE_APP_PERMISSION, decision: DECISION.ALLOW, reasonCode: REASON.NO_CHANGE });
      return { ok: true, changed: false, reasonCode: REASON.NO_CHANGE };
    }
    if (before.organization_id !== gate.user.team_id) return { ok: false, error: REASON.CROSS_DEPARTMENT_DENIED };
    this.store.transactSync(() => this.store.revokeAppGrant(grantId));
    this.#govAudit(gate, {
      action: GOVERNANCE_ACTION.REVOKE_APP_PERMISSION,
      decision: DECISION.ALLOW,
      reasonCode: "ALLOW",
      resourceRef: before.resource_id || null,
      oldPermissions: domain.grantActions(before),
      newPermissions: [],
    });
    return { ok: true, changed: true, reasonCode: "ALLOW" };
  }

  /** App 更新请求权限扩大的 contract：新增权限必须重新批准（真正安装属 D5）。 */
  evaluateAppPermissionUpgrade({ currentActions = [], requestedActions = [] } = {}) {
    return domain.evaluateAppPermissionUpgrade({ currentActions, requestedActions });
  }

  // -------------------------------------------------------------------------
  // Diagnostics
  // -------------------------------------------------------------------------

  authorizationAudit({ context } = {}) {
    const gate = this.#governanceGate(context, GOVERNANCE_ACTION.VIEW_AUDIT);
    if (!gate.ok) return { ok: false, error: gate.error, items: [] };
    const items = this.store.authorizationAudit();
    return { ok: true, items: gate.isSuper ? items : items.filter((a) => (a.department_id ? gate.adminDeptIds.includes(a.department_id) : false)) };
  }
}

module.exports = { AuthorizationService, SESSION_REASON };
