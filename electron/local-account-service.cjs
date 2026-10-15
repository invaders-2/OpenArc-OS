/**
 * B4e · 本地账号服务（部门 / 用户 / APP 访问 / 审计）
 *
 * 源：DX OS 0.5.1，runtime-0.5.5-0b51356e-72a5-4bf1-82e1-1bfc70b3d08d，
 *     app.asar.unpacked/server/auth.ts（801 行）。本文件逐函数移植 auth.ts 中
 *     与"本地账号"相关的部分，**不新建第二套账号体系**：用户 / 部门 / 角色 /
 *     APP 授权 / 审计全部落到 OpenArc 既有表与既有模块。
 *
 * ## 源 → OpenArc 映射表（先读 identity-store.cjs / authorization-*.cjs / identity-service.cjs 确认列名与接口）
 *
 * | 源（server/auth.ts）                        | OpenArc 既有落点                                              | 说明 |
 * |--------------------------------------------|--------------------------------------------------------------|------|
 * | auth_users（19-30, 111）                    | users（identity-store.cjs:109）                               | identifier→username；role 三值→两值，见下 |
 * | auth_users.force_password_change（167-168） | 无对应列                                                      | 不读写；源"首登强制改密"语义不移植（如实登记，不伪造） |
 * | auth_departments（102-109）                 | departments（identity-store.cjs:186）                          | organization_id 承载源"全局唯一"的边界；parent_id 无对应列，恒为 null |
 * | auth_sessions（123-131）                    | sessions（identity-store.cjs:129）                             | 由 identity-service/identity-store 既有接口管理，本服务不直写 |
 * | auth_audit_logs（135-144）                  | audit_log（identity-store.cjs:158）+ authorization_audit（:301）| 事件名保留源语义（auth.login / department.create …）；resourceType/resource_id/detail/ip 在 audit_log 无列，治理动作的归属列进 authorization_audit |
 * | app_access_rules（146-152）                 | app_resource_grants（identity-store.cjs:284）                  | 保留字 resource_type='app-access'、scope='ACCESS'、resource_id=''；actions 存 {mode,departmentIds} |
 * | app_permission_policies（154-163）          | app_resource_grants                                            | 保留字 resource_type='app-permission'、resource_id=permission_code、scope='ACCESS'；actions 存策略对象 |
 * | app_principals（274-298）                   | app_principals（identity-store.cjs:287）                       | OpenArc 内置 App 目录直接复用；源里开发者 App 清单属 B7，走注入。X7：开发者 App 安装/启用时也幂等登记本表（built_in=0），让 app.<manifest.id>.* 权限码的宿主校验通过（见 #permissionHostAppId） |
 *
 * 保留字 resource_type='app-access' / 'app-permission' 与 OpenArc 既有授权家族
 * （'' / 'model' / 'mcp' / 'tool' / 具体资源类型）互不重叠，因此 baselinePolicyKeyOf /
 * policyFamilyOfAppGrant（identity-store.cjs:1357-1381）对它们是 null，不会触发
 * app_policy_provisions 的墓碑 / 播种副作用。
 *
 * ## 角色三值 → 两值（必须知悉的损失）
 *
 * 源 SystemRole = 'superadmin' | 'admin' | 'user'（auth.ts:17）。
 * OpenArc users.role 只有 'ADMIN' | 'MEMBER'（identity-store.cjs:115 CHECK），
 * 部门成员角色是 department_memberships.membership_role='department-admin'|'member'（:204）。
 * 映射：
 *   · superadmin → users.role='ADMIN'
 *   · admin      → users.role='MEMBER' 且存在 ACTIVE department_memberships.membership_role='department-admin'
 *   · user       → 其余 'MEMBER'
 * 因此"没有部门的 admin"在既有两值列 + 部门成员角色表里**无法表达**：
 * createAuthUser / updateAuthUser 对 role='admin' 显式要求 departmentId，否则 DXOS_ERR_INVALID_INPUT。
 * 这是与源的行为差异（源 auth.ts:526-552 允许 admin 无部门），在此明确登记。
 *
 * ## 云 / 商业化 OUT（逐条）
 *
 *   · auth.ts:5  withApiQuotaActor / apiQuota                 —— 计费，OUT：未引入。
 *   · auth.ts:9  currentSignedEntitlement / cloudEntitlement  —— 云端签名权益，OUT：未引入，不做门禁。
 *   · auth.ts:15 BASE_LOCAL_ACCOUNT_LIMIT = 3                 —— 免费版账号上限，OUT：本地不限账号数。
 *   · auth.ts:51-63 LocalAccountEntitlement 的 plan / planName / planGroup /
 *     maxLocalAccounts / maxDepartments / departmentsEnabled / advancedAppPolicyEnabled /
 *     source                                                   —— 全部 OUT：这些签名权益字段一律不伪造；对外只标 local:true。
 *   · auth.ts:209-229 loginEligibleUserIds + publicUser 的 entitlementSuspended（:227）
 *                                                              —— 会员额度挂起，OUT：本地不做账号额度门禁，
 *                                                                 不写 entitlementSuspended；只要 status=active 即可登录。
 *   · auth.ts:339-342 auth.login.entitlement_suspended 审计     —— 删除（无额度概念）。
 *   · auth.ts:360-363 auth.session.entitlement_suspended 审计   —— 删除（无额度概念）。
 *   · auth.ts:450-464 requireDepartmentEntitlement / requireAdvancedAppPolicyEntitlement
 *                                                              —— 部门与精细 APP 权限的会员门禁，OUT：
 *                                                                 本地始终允许创建部门与保存精细 APP 权限。
 *   · auth.ts:735-742 appPermissionSnapshot 的"未开会员 → 全部 mode=all、无 policies"分支
 *                                                              —— OUT：本地始终返回真实配置的快照。
 *
 * ## 依赖注入（必须由装配方注入；未注入即结构化降级，绝不伪造成功）
 *
 *   · deps.appCatalog（开发者 App 目录；装配方 = electron/developer-domain.cjs 的
 *     createDeveloperAppCatalogAdapter，main.cjs 在 developerBundle 之后晚绑定）：
 *       listInstalledApps({ userId, organizationId }) → [{ id, name, desc }]
 *       listPermissionManifests() → [{ appId, appName, permissions: [{ code, label, description }] }]
 *     未注入时：内置 App（app_principals）照常工作；快照里
 *     developerApps = { available:false, code:'AGENT_DEPENDENCY_UNAVAILABLE' }；
 *     permissionManifests = []。权限代码校验退化到源正则（auth.ts:771），不做假清单。
 *
 * ## 与源的其余显式差异（均在此登记）
 *
 *   · 登录令牌不出本服务：源 login 返回 token（auth.ts:350）；本服务只返回 sessionRef，
 *     token 由 identity-service / SessionSecretStore 管理（identity-service.cjs:11-14）。
 *   · 口令强度沿用 OpenArc password.cjs（≥8 位，password.cjs:137），比源"非空即可"（auth.ts:247）更严。
 *   · changeOwnPassword：源保留当前会话（auth.ts:601）；OpenArc changePassword 抬 auth_version
 *     并撤销该用户全部会话（identity-store.cjs:2670），更严，采纳后者。
 *   · 部门为单组织内唯一（departments UNIQUE(organization_id,name)），源为全局唯一。
 *   · listAuthDepartments / 治理动作需要 session context（OpenArc 多租户 + 授权闸门），
 *     源的部分读取函数无鉴权参数、由路由层单独 requireSuperAdmin。
 *   · appPermissionSnapshot 的取数按 subject 的 organization_id 过滤；源是全局单组织，无此列。
 *   · 源 app_access_rules.department_ids_json 与 app_permission_policies 的按用户/部门/角色目标：
 *     源只存不判（canUseAppPermission 仅回落到 canOpenApp，auth.ts:706-714）；
 *     本服务同样只保存与快照，不新增第二套执行期判定。
 *
 * @module electron/local-account-service
 */
"use strict";

const identityDomain = require("./identity-domain.cjs");
const authorizationDomain = require("./authorization-domain.cjs");
const {
  DXOS_ERR_INVALID_INPUT,
  DXOS_ERR_NOT_FOUND,
  DXOS_ERR_CONFLICT,
  DXOS_ERR_FORBIDDEN,
  DXOS_ERR_INTERNAL,
} = require("./dxos-foundation-errors.cjs");

/** 与 B3 各域同字面量的"依赖未接线"结构化码（agent-domain.cjs:29）。 */
const AGENT_DEPENDENCY_UNAVAILABLE = "AGENT_DEPENDENCY_UNAVAILABLE";
/** 源 auth.ts:794 的 403 语义码。 */
const APP_ACCESS_DENIED = "APP_ACCESS_DENIED";

/** 保留在 app_resource_grants 里的两个配置命名空间（见文件头映射表）。 */
const APP_ACCESS_RESOURCE_TYPE = "app-access";
const APP_PERMISSION_RESOURCE_TYPE = "app-permission";
const ACCESS_SCOPE = "ACCESS";
/** 非 app.<id>. 前缀的权限代码的落库宿主 App（app_principals 内置且必然存在）。 */
const HOST_APP_ID = "resource-library";
/** 源 auth.ts:698 的系统入口：不参与 APP 打开规则，且非超级管理员不可打开。 */
const SYSTEM_APP_IDS = Object.freeze(["api-settings", "accounts"]);

const APP_ACCESS_MODES = Object.freeze(["all", "superadmins", "admins", "departments"]);
const PERMISSION_DECISIONS = Object.freeze(["allow", "deny"]);
const DATA_SCOPES = Object.freeze(["all", "department", "departments", "self", "none"]);
const SYSTEM_ROLES = Object.freeze(["superadmin", "admin", "user"]);

/** 源 auth.ts:771 的权限代码形状（回退校验用）。 */
const PERMISSION_CODE_RE = /^app\.[a-z0-9][a-z0-9-]{1,48}\.[a-z][a-z0-9_.:-]{1,96}$/;
const PERMISSION_APP_RE = /^app\.([a-z0-9][a-z0-9-]{1,48})\./;

// ---------------------------------------------------------------------------
// 纯函数：源的 normalizeRule / normalizePolicy / ruleAllows / defaultAppAccessRule
// ---------------------------------------------------------------------------

/** 源 auth.ts:716-719 normalizeRule。 */
function normalizeRule(input) {
  const mode = APP_ACCESS_MODES.includes(input && input.mode) ? input.mode : "all";
  const departmentIds = Array.isArray(input && input.departmentIds)
    ? [...new Set(input.departmentIds.map(String).filter(Boolean))]
    : [];
  return { mode, departmentIds };
}

/** 源 auth.ts:721-730 normalizePolicy。 */
function normalizePolicy(input) {
  const scope = input && input.dataScope;
  const roles = Array.isArray(input && input.roles)
    ? input.roles.filter((role) => SYSTEM_ROLES.includes(role))
    : [];
  return {
    decision: input && input.decision === "allow" ? "allow" : "deny",
    userIds: Array.isArray(input && input.userIds) ? [...new Set(input.userIds.map(String).filter(Boolean))] : [],
    departmentIds: Array.isArray(input && input.departmentIds)
      ? [...new Set(input.departmentIds.map(String).filter(Boolean))]
      : [],
    roles,
    ...(DATA_SCOPES.includes(scope) ? { dataScope: scope } : {}),
  };
}

/** 源 auth.ts:644-649 defaultAppAccessRule（lingxing 例外原样保留；OpenArc 无此 App，不影响其它 App）。 */
function defaultAppAccessRule(appId) {
  return { mode: appId === "lingxing" ? "admins" : "all", departmentIds: [] };
}

/**
 * 源 auth.ts:689-694 ruleAllows。
 * 差异：源用单个 user.departmentId（auth.ts:693），OpenArc 一人可属多部门，
 * 因此这里判"任一 ACTIVE 部门命中即可"。
 */
function ruleAllows(user, rule) {
  if (rule.mode === "all") return true;
  if (rule.mode === "superadmins") return false;
  if (rule.mode === "admins") return user.role === "admin";
  return user.departmentIds.some((id) => rule.departmentIds.includes(id));
}

/** app_resource_grants.actions 里存的配置对象（源原为独立表，见映射表）。 */
function parseStoredObject(value, fallback) {
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    return fallback;
  } catch {
    return fallback;
  }
}

function deriveAppIdOfPermission(permissionCode) {
  const match = String(permissionCode || "").match(PERMISSION_APP_RE);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

class LocalAccountService {
  /**
   * @param opts.identity       已 open 的 IdentityStore（用户 / session / audit_log 权威）
   * @param opts.authStore      AuthorizationStore（部门 / membership / app_resource_grants / authorization_audit）
   * @param opts.authorization  AuthorizationService（治理闸门 + 既有治理接口）
   * @param opts.identityService 可选 IdentityService；提供时 session 生命周期走命令层（推荐），
   *                             否则回落到 IdentityStore 的既有方法
   * @param opts.deps           可选注入：{ appCatalog }（开发者 App 目录；也可经 attachAppCatalog 晚绑定）
   */
  constructor({ identity, authStore, authorization, identityService = null, deps = {} } = {}) {
    if (!identity) throw new Error("LocalAccountService 需要 IdentityStore");
    if (!authStore) throw new Error("LocalAccountService 需要 AuthorizationStore");
    if (!authorization) throw new Error("LocalAccountService 需要 AuthorizationService");
    this.identity = identity;
    this.authStore = authStore;
    this.authorization = authorization;
    this.identityService = identityService || null;
    this.attachAppCatalog(deps ? deps.appCatalog : null);
  }

  /**
   * 晚绑定 developer App 目录：identity 先于 developerBundle 装配（main.cjs 装配点），
   * 构造期拿不到该实例。形状不符时保持"未注入"的降级语义，不伪造目录。
   * @returns {boolean} 是否接上
   */
  attachAppCatalog(appCatalog) {
    this.appCatalog = appCatalog && typeof appCatalog.listInstalledApps === "function" ? appCatalog : null;
    return !!this.appCatalog;
  }

  // -------------------------------------------------------------------------
  // 内部：错误 / 审计 / 投影
  // -------------------------------------------------------------------------

  #fail(error, message, detail) {
    return { ok: false, error, ...(message ? { message } : {}), ...(detail !== undefined ? { detail } : {}) };
  }

  #fromIdentity(res) {
    if (res && res.ok) return null;
    return this.#fail((res && res.error) || DXOS_ERR_INTERNAL, undefined, res ? res.detail : undefined);
  }

  /** 源 auth.ts:279-285 audit()：事件名保留，落到 audit_log（表无 detail 列，见文件头映射表）。 */
  #audit(event, { userId = null, sessionRef = null, result = "OK", errorCode = null } = {}) {
    return this.identity.audit(event, { userId, sessionRef, result, errorCode });
  }

  /** 治理归属审计落 authorization_audit（源 auth_audit_logs.resource_type/resource_id 的等价物）。 */
  #authzAudit({ actorUserId, targetUserId = null, appId = null, departmentId = null, action, decision, reasonCode, newPermissions = null }) {
    return this.authStore.auditAuthorization({
      actorUserId,
      targetUserId,
      appId,
      departmentId,
      action,
      decision,
      reasonCode,
      permissionSource: "SUPER_ADMIN",
      newPermissions,
    });
  }

  /** 源 auth.ts:223-229 publicUser + 角色映射（见文件头）。源无 displayName，这里作为附加字段给出。 */
  #publicUser(row) {
    if (!row) return null;
    const memberships = this.authStore.membershipsOfUser(row.id).filter((m) => m.status === "ACTIVE");
    const departmentIds = memberships.map((m) => m.department_id);
    let role = "user";
    if (row.role === identityDomain.USER_ROLE.ADMIN) role = "superadmin";
    else if (memberships.some((m) => m.membership_role === authorizationDomain.MEMBERSHIP_ROLE.DEPARTMENT_ADMIN)) role = "admin";
    return {
      id: row.id,
      username: row.identifier,
      displayName: row.display_name,
      departmentId: departmentIds[0] || null,
      departmentIds,
      role,
      status: String(row.status).toLowerCase(),
      local: true,
    };
  }

  /** 源 requireSuperAdmin（auth.ts:379-387）在本服务的等价闸门（走既有授权服务，不自己判 role）。 */
  #requireSuper(context) {
    if (!context || !context.sessionRef) {
      return this.#fail(DXOS_ERR_FORBIDDEN, "请先登录");
    }
    const actor = this.authorization.resolveActor({ context });
    if (!actor.ok) return this.#fail(actor.error, "请先登录");
    if (!actor.isSuper) return this.#fail("NOT_SUPER_ADMIN", "需要超级管理员权限");
    return { ok: true, user: actor.user };
  }

  #sessionDays() {
    const ttl = Number.isFinite(this.identity.ttlMs) ? this.identity.ttlMs : 30 * 24 * 60 * 60 * 1000;
    return Math.max(1, Math.round(ttl / (24 * 60 * 60 * 1000)));
  }

  // -------------------------------------------------------------------------
  // session 生命周期：优先 identity-service 命令层，回落到 IdentityStore 既有方法
  // -------------------------------------------------------------------------

  async #initializeRaw(input) {
    if (this.identityService) return this.identityService.dispatch({ type: "identity/initialize", ...input });
    return this.identity.initialize(input);
  }

  async #loginRaw({ identifier, password, source }) {
    if (this.identityService) return this.identityService.dispatch({ type: "identity/login", identifier, password });
    return this.identity.login({ identifier, password, source });
  }

  async #logoutRaw(sessionRef) {
    if (this.identityService) return this.identityService.dispatch({ type: "identity/logout", sessionRef });
    return this.identity.logout(sessionRef);
  }

  async #changePasswordRaw({ sessionRef, currentPassword, newPassword }) {
    if (this.identityService) {
      return this.identityService.dispatch({
        type: "identity/change-password",
        sessionRef,
        currentPassword,
        newPassword,
      });
    }
    return this.identity.changePassword(sessionRef, currentPassword, newPassword);
  }

  // -------------------------------------------------------------------------
  // 账号状态 / 初始化 / 登录 / 登出
  // -------------------------------------------------------------------------

  /** 源 auth.ts:307-310 authStatus。不再返回任何签名权益字段，只标 local:true。 */
  authStatus() {
    const st = this.identity.status();
    return { ok: true, initialized: st.initialized, sessionDays: this.#sessionDays(), local: true };
  }

  /** 源 auth.ts:312-331 bootstrap：首建超级管理员并登录；审计只写 auth.bootstrap（源同）。 */
  async bootstrap({ identifier, password, displayName, source = "local" } = {}) {
    const name = String(displayName == null ? identifier : displayName).trim();
    const init = await this.#initializeRaw({ identifier, password, displayName: name });
    const initErr = this.#fromIdentity(init, "bootstrap");
    if (initErr) return initErr;
    const login = await this.#loginRaw({ identifier, password, source });
    const loginErr = this.#fromIdentity(login, "bootstrap");
    if (loginErr) return loginErr;
    const userId = (login.user && login.user.id) || (login.snapshot && login.snapshot.user && login.snapshot.user.id) || init.userId || null;
    const sessionRef = (login.session && login.session.ref) || (login.snapshot && login.snapshot.sessionRef) || null;
    this.#audit("auth.bootstrap", { userId, sessionRef, result: "OK" });
    return { ok: true, user: this.#publicUser(this.identity.userById(userId)), sessionRef, installationId: init.installationId || null };
  }

  /** 源 auth.ts:333-351 login。额度挂起分支（:339-342）已 OUT；失败统一 auth.login.failed。 */
  async login({ identifier, password, source = "local" } = {}) {
    const res = await this.#loginRaw({ identifier, password, source });
    if (!res || !res.ok) {
      this.#audit("auth.login.failed", { result: "DENY", errorCode: (res && res.error) || DXOS_ERR_INTERNAL });
      return this.#fromIdentity(res, "login");
    }
    const userId = (res.user && res.user.id) || (res.snapshot && res.snapshot.user && res.snapshot.user.id) || null;
    const sessionRef = (res.session && res.session.ref) || (res.snapshot && res.snapshot.sessionRef) || null;
    this.#audit("auth.login", { userId, sessionRef, result: "OK" });
    return { ok: true, user: this.#publicUser(this.identity.userById(userId)), sessionRef };
  }

  /** 源 auth.ts:398-404 logout。源仅在 getAuth 成功时写 auth.logout；这里成功才写。 */
  async logout({ sessionRef } = {}) {
    if (!sessionRef) return this.#fail(DXOS_ERR_FORBIDDEN, "缺少会话");
    const before = this.identity.sessionByRef(sessionRef);
    const res = await this.#logoutRaw(sessionRef);
    if (!res || !res.ok) return this.#fromIdentity(res, "logout");
    this.#audit("auth.logout", { userId: before ? before.user_id : null, sessionRef, result: "OK" });
    return { ok: true, revoked: true };
  }

  // -------------------------------------------------------------------------
  // 部门（源 auth.ts:466-517）
  // -------------------------------------------------------------------------

  /** 源 auth.ts:420-423 的部门版本（466-470）。 */
  listAuthDepartments({ context } = {}) {
    const res = this.authorization.listDepartments({ context });
    if (!res.ok) return this.#fail(res.error, "需要管理员权限", undefined);
    return { ok: true, items: res.items.map((d) => this.#departmentView(d)) };
  }

  #departmentView(row) {
    return { id: row.id, name: row.name, parentId: null, status: String(row.status).toLowerCase() };
  }

  /** 源 auth.ts:472-487 createAuthDepartment。会员门禁（:473）已 OUT。 */
  createAuthDepartment({ context, name, description = "" } = {}) {
    const gate = this.#requireSuper(context);
    if (!gate.ok) return gate;
    const trimmed = String(name == null ? "" : name).trim();
    if (trimmed.length < 2) return this.#fail(DXOS_ERR_INVALID_INPUT, "部门名称至少需要 2 个字符");
    const exists = this.authStore
      .departmentsOfOrg(gate.user.team_id)
      .some((d) => d.name === trimmed);
    if (exists) return this.#fail(DXOS_ERR_CONFLICT, "已存在同名部门");
    const res = this.authorization.createDepartment({ context, name: trimmed, description });
    if (!res.ok) return this.#fail(res.error, "创建部门失败");
    this.#audit("department.create", { userId: gate.user.id, result: "OK" });
    return { ok: true, department: this.#departmentView(res.department) };
  }

  /** 源 auth.ts:489-505 updateAuthDepartment。会员门禁（:490）已 OUT。 */
  updateAuthDepartment({ context, departmentId, name, description, status } = {}) {
    const gate = this.#requireSuper(context);
    if (!gate.ok) return gate;
    const dept = this.authStore.departmentById(departmentId);
    if (!dept || dept.organization_id !== gate.user.team_id) return this.#fail(DXOS_ERR_NOT_FOUND, "部门不存在");
    if (name !== undefined) {
      const trimmed = String(name == null ? "" : name).trim();
      if (trimmed.length < 2) return this.#fail(DXOS_ERR_INVALID_INPUT, "部门名称至少需要 2 个字符");
      const dup = this.authStore
        .departmentsOfOrg(gate.user.team_id)
        .some((d) => d.name === trimmed && d.id !== dept.id);
      if (dup) return this.#fail(DXOS_ERR_CONFLICT, "已存在同名部门");
    }
    const nextStatus = status === undefined ? undefined : status === "disabled" ? "DISABLED" : "ACTIVE";
    const res = this.authorization.updateDepartment({
      context,
      departmentId,
      name,
      description,
      ...(nextStatus === undefined ? {} : { status: nextStatus }),
    });
    if (!res.ok) return this.#fail(res.error, "更新部门失败");
    this.#audit("department.update", { userId: gate.user.id, result: "OK" });
    return { ok: true, department: this.#departmentView(res.department) };
  }

  /**
   * 源 auth.ts:507-517 deleteAuthDepartment。会员门禁（:508）已 OUT。
   * 源把用户的 department_id 置空再删（:512-513）；OpenArc 的等价物是删除成员关系。
   * 若仍有 resource_registry 行挂在该部门（外键），返回 CONFLICT，不级联改动 B5 资源归属。
   */
  deleteAuthDepartment({ context, departmentId } = {}) {
    const gate = this.#requireSuper(context);
    if (!gate.ok) return gate;
    const dept = this.authStore.departmentById(departmentId);
    if (!dept || dept.organization_id !== gate.user.team_id) return this.#fail(DXOS_ERR_NOT_FOUND, "部门不存在");
    const linked = this.identity.connection
      .prepare("SELECT COUNT(*) AS c FROM resource_registry WHERE department_id = ?")
      .get(dept.id);
    if (linked && Number(linked.c) > 0) {
      return this.#fail(DXOS_ERR_CONFLICT, "该部门下仍有资源，未删除（请先迁移资源归属）");
    }
    this.identity.transactSync(() => {
      const db = this.identity.connection;
      db.prepare("DELETE FROM department_memberships WHERE department_id = ?").run(dept.id);
      db.prepare("DELETE FROM departments WHERE id = ?").run(dept.id);
    });
    this.#audit("department.delete", { userId: gate.user.id, result: "OK" });
    this.#authzAudit({
      actorUserId: gate.user.id,
      departmentId: dept.id,
      action: "department.delete",
      decision: "ALLOW",
      reasonCode: "ALLOW",
    });
    return { ok: true, deleted: true };
  }

  // -------------------------------------------------------------------------
  // 用户（源 auth.ts:420-423, 526-619）
  // -------------------------------------------------------------------------

  /** 源 auth.ts:420-423 listAuthUsers（配合 :223-229 publicUser）。 */
  listAuthUsers() {
    return { ok: true, items: this.identity.allUsers().map((row) => this.#publicUser(row)) };
  }

  /**
   * B7f · 审计读取（只读，超管面）。数据源是既有 audit_log / authorization_audit 的真实行：
   *   · 字段投影去敏：不返回 session_ref_hash / request_id / old_permissions 等敏感列；
   *   · 分页（limit / offset）+ 按事件名（audit_log.event / authorization_audit.action）与时间过滤；
   *   · result 收敛成 UI 可分支的 OK / DENY（audit_log 的 PARTIAL / ERROR 一律记 DENY）。
   */
  listAuditEvents({ context, event = null, since = null, until = null, limit = 50, offset = 0 } = {}) {
    const gate = this.#requireSuper(context);
    if (!gate.ok) return gate;
    const name = typeof event === "string" && event.trim() ? event.trim().slice(0, 120) : null;
    const from = since === null || since === undefined || !Number.isFinite(Number(since)) ? null : Number(since);
    const to = until === null || until === undefined || !Number.isFinite(Number(until)) ? null : Number(until);
    const max = Math.max(1, Math.min(200, Math.trunc(Number(limit)) || 50));
    const skip = Math.max(0, Math.trunc(Number(offset)) || 0);
    const db = this.identity.connection;
    const rows = [];

    const auditSql = ["SELECT at, event, user_ref, result, error_code FROM audit_log WHERE 1=1"];
    const auditParams = [];
    if (name) { auditSql.push("AND event = ?"); auditParams.push(name); }
    if (from !== null) { auditSql.push("AND at >= ?"); auditParams.push(from); }
    if (to !== null) { auditSql.push("AND at <= ?"); auditParams.push(to); }
    for (const row of db.prepare(auditSql.join(" ")).all(...auditParams)) {
      rows.push({ source: "audit_log", at: Number(row.at) || 0, event: String(row.event || ""), result: String(row.result) === "OK" ? "OK" : "DENY", errorCode: row.error_code || null, actor: row.user_ref || null, target: null, sources: ["audit_log"] });
    }

    const authzSql = ["SELECT at, actor_user_id, target_user_id, app_id, department_id, action, decision, reason_code FROM authorization_audit WHERE 1=1"];
    const authzParams = [];
    if (name) { authzSql.push("AND action = ?"); authzParams.push(name); }
    if (from !== null) { authzSql.push("AND at >= ?"); authzParams.push(from); }
    if (to !== null) { authzSql.push("AND at <= ?"); authzParams.push(to); }
    for (const row of db.prepare(authzSql.join(" ")).all(...authzParams)) {
      rows.push({ source: "authorization_audit", at: Number(row.at) || 0, event: String(row.action || ""), result: String(row.decision) === "ALLOW" ? "OK" : "DENY", errorCode: row.reason_code || null, actor: row.actor_user_id || null, target: row.target_user_id || row.app_id || row.department_id || null, sources: ["authorization_audit"] });
    }

    rows.sort((a, b) => (b.at - a.at) || (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
    return { ok: true, items: rows.slice(skip, skip + max), total: rows.length, limit: max, offset: skip, sources: ["audit_log", "authorization_audit"] };
  }

  /** 源 auth.ts:429-448 localAccountEntitlement 的本地替代：只给真实计数，无签名权益/上限字段。 */
  localAccountInfo() {
    const deptCount = this.identity.connection.prepare("SELECT COUNT(*) AS c FROM departments").get();
    return {
      ok: true,
      local: true,
      initialized: this.identity.status().initialized,
      userCount: this.identity.userCount(),
      departmentCount: Number(deptCount && deptCount.c) || 0,
    };
  }

  #validDepartment(organizationId, departmentId) {
    const dept = this.authStore.departmentById(departmentId);
    if (!dept || dept.organization_id !== organizationId || dept.status !== "ACTIVE") return null;
    return dept;
  }

  #createUserMessage(error) {
    if (error === "INVALID_INPUT") return "用户名已存在或输入不合法";
    if (error === "NOT_SUPER_ADMIN") return "需要超级管理员权限";
    return "创建用户失败";
  }

  /**
   * 源 auth.ts:526-552 createAuthUser。
   * 差异：额度检查（:537-540）已 OUT；role='admin' 需要 departmentId（见文件头角色映射）。
   */
  async createAuthUser({ context, identifier, password, displayName, departmentId = null, role = "user" } = {}) {
    const gate = this.#requireSuper(context);
    if (!gate.ok) return gate;
    const rawId = String(identifier == null ? "" : identifier).trim();
    if (rawId.length < 2) return this.#fail(DXOS_ERR_INVALID_INPUT, "用户名至少需要 2 个字符");
    if (!String(password == null ? "" : password).length) return this.#fail(DXOS_ERR_INVALID_INPUT, "密码不能为空");
    const dxRole = SYSTEM_ROLES.includes(role) ? role : "user";
    if (dxRole === "admin" && !departmentId) {
      return this.#fail(
        DXOS_ERR_INVALID_INPUT,
        "admin 角色需要 departmentId（既有两值 role 列用 department-admin 成员关系承载 admin）",
      );
    }
    if (departmentId && !this.#validDepartment(gate.user.team_id, departmentId)) {
      return this.#fail(DXOS_ERR_INVALID_INPUT, "所属部门不存在或已停用");
    }
    const openArcRole = dxRole === "superadmin" ? identityDomain.USER_ROLE.ADMIN : identityDomain.USER_ROLE.MEMBER;
    const name = String(displayName == null ? rawId : displayName).trim();
    const created = await this.authorization.createUser({ context, identifier: rawId, password, displayName: name, role: openArcRole });
    if (!created.ok) return this.#fail(created.error, this.#createUserMessage(created.error));
    if (departmentId) {
      const membershipRole =
        dxRole === "admin" ? authorizationDomain.MEMBERSHIP_ROLE.DEPARTMENT_ADMIN : authorizationDomain.MEMBERSHIP_ROLE.MEMBER;
      const added = this.authorization.addDepartmentMember({ context, departmentId, userId: created.userId, membershipRole });
      if (!added.ok) {
        this.#audit("user.create", { userId: gate.user.id, result: "PARTIAL", errorCode: added.error });
        return {
          ok: true,
          partial: true,
          warning: "用户已创建，部门成员关系未建立：" + added.error,
          user: this.#publicUser(this.identity.userById(created.userId)),
        };
      }
    }
    this.#audit("user.create", { userId: gate.user.id, result: "OK" });
    return { ok: true, user: this.#publicUser(this.identity.userById(created.userId)) };
  }

  #clearMemberships({ context, userId }) {
    const memberships = this.authStore.membershipsOfUser(userId).filter((m) => m.status === "ACTIVE");
    for (const m of memberships) {
      const res = this.authorization.removeDepartmentMember({ context, departmentId: m.department_id, userId });
      if (!res.ok) return this.#fail(res.error, "移除部门成员关系失败");
    }
    return { ok: true };
  }

  #setPrimaryDepartment({ context, userId, departmentId, membershipRole }) {
    const memberships = this.authStore.membershipsOfUser(userId);
    for (const m of memberships) {
      if (m.department_id !== departmentId) {
        const res = this.authorization.removeDepartmentMember({ context, departmentId: m.department_id, userId });
        if (!res.ok) return this.#fail(res.error, "移除部门成员关系失败");
      }
    }
    const res = this.authorization.addDepartmentMember({ context, departmentId, userId, membershipRole });
    if (!res.ok) return this.#fail(res.error, "设置部门成员关系失败");
    return { ok: true };
  }

  #assignRole({ context, userId, role, departmentId }) {
    if (role === "superadmin") {
      const res = this.authorization.setUserRole({ context, userId, role: identityDomain.USER_ROLE.ADMIN });
      if (!res.ok) return this.#fail(res.error, "设置角色失败");
      return { ok: true };
    }
    const base = this.authorization.setUserRole({ context, userId, role: identityDomain.USER_ROLE.MEMBER });
    if (!base.ok) return this.#fail(base.error, "设置角色失败");
    const memberships = this.authStore.membershipsOfUser(userId).filter((m) => m.status === "ACTIVE");
    if (role === "admin") {
      const targetDept = departmentId || (memberships[0] && memberships[0].department_id) || null;
      if (!targetDept) {
        return this.#fail(DXOS_ERR_INVALID_INPUT, "admin 角色需要部门（department-admin 成员关系承载 admin）");
      }
      const res = this.authorization.addDepartmentMember({
        context,
        departmentId: targetDept,
        userId,
        membershipRole: authorizationDomain.MEMBERSHIP_ROLE.DEPARTMENT_ADMIN,
      });
      if (!res.ok) return this.#fail(res.error, "设置部门管理员失败");
      return { ok: true };
    }
    for (const m of memberships) {
      if (m.membership_role !== authorizationDomain.MEMBERSHIP_ROLE.MEMBER) {
        const res = this.authorization.addDepartmentMember({
          context,
          departmentId: m.department_id,
          userId,
          membershipRole: authorizationDomain.MEMBERSHIP_ROLE.MEMBER,
        });
        if (!res.ok) return this.#fail(res.error, "降级部门成员失败");
      }
    }
    return { ok: true };
  }

  /**
   * 源 auth.ts:561-583 updateAuthUser。
   * 差异：源允许改名/改部门（单值）；这里改名走既有 users.identifier，部门用成员关系承载并收敛为单主部门。
   */
  async updateAuthUser({ context, userId, username, departmentId, role, status } = {}) {
    const gate = this.#requireSuper(context);
    if (!gate.ok) return gate;
    const row = this.identity.userById(userId);
    if (!row || row.team_id !== gate.user.team_id) return this.#fail(DXOS_ERR_NOT_FOUND, "用户不存在");

    if (username !== undefined) {
      const normalized = identityDomain.normalizeIdentifier(username);
      if (normalized.length < 2) return this.#fail(DXOS_ERR_INVALID_INPUT, "用户名至少需要 2 个字符");
      if (normalized !== row.identifier) {
        const other = this.identity.userByIdentifier(normalized);
        if (other && other.id !== row.id) return this.#fail(DXOS_ERR_CONFLICT, "用户名已存在");
        this.identity.transactSync(() => {
          this.identity.connection
            .prepare("UPDATE users SET identifier = ?, updated_at = ? WHERE id = ?")
            .run(normalized, this.identity.clock(), row.id);
        });
      }
    }

    if (status !== undefined) {
      const next = status === "disabled" ? identityDomain.USER_STATUS.DISABLED : identityDomain.USER_STATUS.ACTIVE;
      const res = this.authorization.setUserStatus({ context, userId, status: next });
      if (!res.ok) return this.#fail(res.error, "更新用户状态失败");
    }

    if (departmentId !== undefined) {
      if (departmentId === null || departmentId === "") {
        const cleared = this.#clearMemberships({ context, userId });
        if (!cleared.ok) return cleared;
      } else {
        const dept = this.#validDepartment(gate.user.team_id, departmentId);
        if (!dept) return this.#fail(DXOS_ERR_INVALID_INPUT, "所属部门不存在或已停用");
        const membershipRole =
          role === "admin" ? authorizationDomain.MEMBERSHIP_ROLE.DEPARTMENT_ADMIN : authorizationDomain.MEMBERSHIP_ROLE.MEMBER;
        const applied = this.#setPrimaryDepartment({ context, userId, departmentId: dept.id, membershipRole });
        if (!applied.ok) return applied;
      }
    }

    if (role !== undefined) {
      const dxRole = SYSTEM_ROLES.includes(role) ? role : "user";
      const assigned = this.#assignRole({ context, userId, role: dxRole, departmentId: departmentId || null });
      if (!assigned.ok) return assigned;
    }

    this.#audit("user.update", { userId: gate.user.id, result: "OK" });
    return { ok: true, user: this.#publicUser(this.identity.userById(userId)) };
  }

  /**
   * 源 auth.ts:585-592 resetAuthPassword。源置 force_password_change=1（无列可落，见文件头）。
   */
  async resetAuthPassword({ context, userId, password } = {}) {
    const gate = this.#requireSuper(context);
    if (!gate.ok) return gate;
    const row = this.identity.userById(userId);
    if (!row || row.team_id !== gate.user.team_id) return this.#fail(DXOS_ERR_NOT_FOUND, "用户不存在");
    const res = await this.identity.adminSetPassword({ userId, newPassword: password });
    if (!res.ok) return this.#fail(res.error, "重置密码失败");
    this.#audit("user.password.reset", { userId: gate.user.id, result: "OK" });
    return { ok: true, userId: res.userId, revokedSessions: res.revokedSessions };
  }

  /**
   * 源 auth.ts:594-603 changeOwnPassword。
   * 差异：源保留当前会话（:601）；OpenArc changePassword 抬 auth_version 并撤销全部会话（更严）。
   */
  async changeOwnPassword({ context, oldPassword, newPassword } = {}) {
    if (!context || !context.sessionRef) return this.#fail(DXOS_ERR_FORBIDDEN, "请先登录");
    const actor = this.authorization.resolveActor({ context });
    if (!actor.ok) return this.#fail(actor.error, "请先登录");
    const next = String(newPassword == null ? "" : newPassword);
    if (next.length < 6) return this.#fail(DXOS_ERR_INVALID_INPUT, "新密码至少 6 位");
    if (next === oldPassword) return this.#fail(DXOS_ERR_INVALID_INPUT, "新密码不能与旧密码相同");
    const res = await this.#changePasswordRaw({
      sessionRef: context.sessionRef,
      currentPassword: oldPassword,
      newPassword: next,
    });
    const err = this.#fromIdentity(res, "change-own-password");
    if (err) return err;
    this.#audit("user.password.change", { userId: actor.user.id, result: "OK" });
    return { ok: true, requiresLogin: true, revokedAllSessions: true };
  }

  /** 源 auth.ts:605-619 deleteAuthUser：保留审计行，解除对该用户的外键引用后才删。 */
  deleteAuthUser({ context, userId } = {}) {
    const gate = this.#requireSuper(context);
    if (!gate.ok) return gate;
    const row = this.identity.userById(userId);
    if (!row || row.team_id !== gate.user.team_id) return this.#fail(DXOS_ERR_NOT_FOUND, "用户不存在");
    if (row.role === identityDomain.USER_ROLE.ADMIN) {
      const others = this.identity
        .allUsers()
        .filter((u) => u.role === identityDomain.USER_ROLE.ADMIN && u.status === identityDomain.USER_STATUS.ACTIVE && u.id !== row.id);
      if (!others.length) return this.#fail(DXOS_ERR_CONFLICT, "系统必须保留至少一位启用的超级管理员");
    }
    this.identity.transactSync(() => {
      const db = this.identity.connection;
      db.prepare("DELETE FROM sessions WHERE user_id = ?").run(row.id);
      db.prepare("DELETE FROM department_memberships WHERE user_id = ?").run(row.id);
      db.prepare("UPDATE authorization_audit SET actor_user_id = NULL WHERE actor_user_id = ?").run(row.id);
      db.prepare("UPDATE app_resource_grants SET granted_by = NULL WHERE granted_by = ?").run(row.id);
      db.prepare("UPDATE app_policy_provisions SET provisioned_by = NULL WHERE provisioned_by = ?").run(row.id);
      db.prepare("UPDATE app_policy_provisions SET revoked_by = NULL WHERE revoked_by = ?").run(row.id);
      db.prepare("DELETE FROM users WHERE id = ?").run(row.id);
    });
    this.#audit("user.delete", { userId: gate.user.id, result: "OK" });
    this.#authzAudit({
      actorUserId: gate.user.id,
      targetUserId: row.id,
      action: "user.delete",
      decision: "ALLOW",
      reasonCode: "ALLOW",
    });
    return { ok: true, deleted: true };
  }

  // -------------------------------------------------------------------------
  // APP 目录 / 访问（源 auth.ts:621-800）
  // -------------------------------------------------------------------------

  #developerApps(user) {
    if (!this.appCatalog) {
      return { available: false, code: AGENT_DEPENDENCY_UNAVAILABLE, items: [] };
    }
    let items = [];
    try {
      items = this.appCatalog.listInstalledApps({ userId: user ? user.id : null, organizationId: user ? user.team_id : null }) || [];
    } catch {
      items = [];
    }
    const list = Array.isArray(items) ? items : [];
    const normalized = list
      .filter((item) => item && item.id)
      .map((item) => ({
        id: String(item.id),
        name: String(item.name || item.id),
        desc: String(item.desc || item.name || item.id),
        developer: true,
      }));
    return { available: true, items: normalized };
  }

  #catalog(user) {
    const apps = this.authStore.allApps().map((a) => ({
      id: a.app_id,
      name: a.name,
      // app_principals 无 description 列（identity-store.cjs:274-282）：desc 回落到 name，不编造描述。
      desc: a.name,
      status: a.status,
    }));
    const byId = new Map(apps.map((a) => [a.id, a]));
    const developer = this.#developerApps(user);
    for (const item of developer.items) if (!byId.has(item.id)) byId.set(item.id, item);
    return { apps: [...byId.values()], developerApps: developer };
  }

  /**
   * 源 auth.ts:652-679 按用户过滤、:681-683 不过滤两条调用点分开：
   * 给 userId 时对齐 appPermissionSnapshot 的 installedIds（只看该用户已安装的 App）；
   * 不给时是 knownPermissionCodes / permissionHostAppId 需要的全量清单，行为不变。
   */
  #permissionManifests(userId) {
    if (!this.appCatalog || typeof this.appCatalog.listPermissionManifests !== "function") return [];
    try {
      const manifests = this.appCatalog.listPermissionManifests(userId ? { userId: String(userId) } : {}) || [];
      return Array.isArray(manifests) ? manifests : [];
    } catch {
      return [];
    }
  }

  #knownPermissionCodes() {
    const codes = new Set();
    for (const manifest of this.#permissionManifests()) {
      for (const permission of (manifest && manifest.permissions) || []) {
        if (permission && permission.code) codes.add(String(permission.code));
      }
    }
    return codes;
  }

  /**
   * X7：权限码 → 宿主 App 的权威解析（先按"声明它的 App"，拿不到再回落字面量切分）。
   *
   * 内置 App 的权限码字面量前缀就是 app_principals.app_id（如 app.photoshop.export → photoshop），
   * 但开发者 App 不同：安装 appId 是 "dev-" + manifest.id（developer-service.cjs install），
   * 而 normalizeAppPermission 生成的权限码前缀是 manifest.id（developer-domain.cjs:491-493），
   * 两者不在同一命名空间。developer Catalog 的 manifest.appId 是安装 appId，是权威映射。
   * 注意：这里只改"怎么解析出 hostApp"，仍然要求 appById(hostApp) 真实存在 —— 校验强度不变。
   */
  #permissionHostAppId(code) {
    // 只对 app.<id>.* 形态生效。无前缀的声明（如 "dev.custom"）在既有语义里宿主是 HOST_APP_ID
    // （local-account-service.cjs:108、开发者包里的非标准权限码原样保留），不由这里改写。
    if (!deriveAppIdOfPermission(code)) return null;
    for (const manifest of this.#permissionManifests()) {
      if (!manifest || !Array.isArray(manifest.permissions)) continue;
      if (manifest.permissions.some((permission) => permission && String(permission.code) === code)) {
        return String(manifest.appId);
      }
    }
    return null;
  }

  /** 源 auth.ts:732-755 appPermissionSnapshot；会员门禁分支（:735-742）已 OUT。 */
  #snapshot(row) {
    const catalog = this.#catalog(row);
    const appIds = new Set(catalog.apps.map((a) => a.id));
    const grants = this.authStore.allAppGrants().filter((g) => g.organization_id === row.team_id);

    const externalAppAccess = {};
    for (const app of catalog.apps) externalAppAccess[app.id] = defaultAppAccessRule(app.id);
    for (const g of grants) {
      if (g.resource_type !== APP_ACCESS_RESOURCE_TYPE || !appIds.has(g.app_id)) continue;
      const stored = parseStoredObject(g.actions, null);
      if (stored) externalAppAccess[g.app_id] = normalizeRule(stored);
    }
    // 源 auth.ts:748-749：应用市场不能被历史策略锁在管理员后面。
    if (appIds.has("market")) externalAppAccess.market = defaultAppAccessRule("market");

    const permissionPolicies = {};
    for (const g of grants) {
      if (g.resource_type !== APP_PERMISSION_RESOURCE_TYPE) continue;
      const stored = parseStoredObject(g.actions, null);
      if (stored) permissionPolicies[g.resource_id] = normalizePolicy(stored);
    }

    return {
      apps: catalog.apps,
      externalAppAccess,
      permissionPolicies,
      permissionManifests: this.#permissionManifests(row.id),
      developerApps: catalog.developerApps,
      local: true,
    };
  }

  #resolveUser(userOrId) {
    if (!userOrId) return null;
    if (typeof userOrId === "string") return this.identity.userById(userOrId);
    if (typeof userOrId === "object" && userOrId.id) return this.identity.userById(userOrId.id) || userOrId;
    return null;
  }

  /** 判定用的用户投影：源用 AuthUser.role + 单 departmentId，这里从既有行 + 成员关系重算。 */
  #openContext(row) {
    const memberships = this.authStore.membershipsOfUser(row.id).filter((m) => m.status === "ACTIVE");
    let role = "user";
    if (row.role === identityDomain.USER_ROLE.ADMIN) role = "superadmin";
    else if (memberships.some((m) => m.membership_role === authorizationDomain.MEMBERSHIP_ROLE.DEPARTMENT_ADMIN)) role = "admin";
    return {
      id: row.id,
      role,
      departmentId: memberships[0] ? memberships[0].department_id : null,
      departmentIds: memberships.map((m) => m.department_id),
    };
  }

  /** 源 auth.ts:630-642 installedAppAccessCatalog + :696-704 canOpenApp。 */
  canOpenApp(userOrId, appId) {
    const row = this.#resolveUser(userOrId);
    if (!row) return false;
    const openCtx = this.#openContext(row);
    if (openCtx.role === "superadmin") return true;
    const id = String(appId == null ? "" : appId);
    if (SYSTEM_APP_IDS.includes(id)) return false;
    const snapshot = this.#snapshot(row);
    if (!snapshot.apps.some((app) => app.id === id)) return true;
    const rule = snapshot.externalAppAccess[id] || defaultAppAccessRule(id);
    return ruleAllows(openCtx, rule);
  }

  /** 源 auth.ts:706-714 canUseAppPermission（不读 permissionPolicies，源同）。 */
  canUseAppPermission(userOrId, permissionCode) {
    const code = String(permissionCode == null ? "" : permissionCode).trim();
    if (!code) return true;
    const row = this.#resolveUser(userOrId);
    if (!row) return false;
    const appId = deriveAppIdOfPermission(code);
    return appId ? this.canOpenApp(row, appId) : true;
  }

  /** 源 auth.ts:732-755 appPermissionSnapshot。 */
  appPermissionSnapshot({ userId } = {}) {
    const row = typeof userId === "string" ? this.identity.userById(userId) : this.#resolveUser(userId);
    if (!row) return this.#fail(DXOS_ERR_NOT_FOUND, "用户不存在");
    return { ok: true, ...this.#snapshot(row) };
  }

  /** 源 auth.ts:784-788 appAccessSummary。 */
  appAccessSummary(userOrId) {
    const row = this.#resolveUser(userOrId);
    if (!row) return this.#fail(DXOS_ERR_NOT_FOUND, "用户不存在");
    const snapshot = this.#snapshot(row);
    const ids = [...snapshot.apps.map((app) => app.id), ...SYSTEM_APP_IDS];
    const summary = {};
    for (const id of ids) summary[id] = this.canOpenApp(row, id);
    return { ok: true, summary };
  }

  /** 源 auth.ts:790-800 requireAppOpen 的判定版（无 express）：允许 {ok:true}，否则 APP_ACCESS_DENIED。 */
  requireAppOpen({ context, appId } = {}) {
    if (!context || !context.sessionRef) return this.#fail(DXOS_ERR_FORBIDDEN, "请先登录");
    const actor = this.authorization.resolveActor({ context });
    if (!actor.ok) return this.#fail(actor.error, "请先登录");
    if (!this.canOpenApp(actor.user, appId)) {
      return { ok: false, error: APP_ACCESS_DENIED, message: "当前账户没有打开该应用的权限" };
    }
    return { ok: true, allowed: true };
  }

  /** 源 auth.ts:757-767 saveAppAccessRule。会员门禁（:758）已 OUT。 */
  saveAppAccessRule({ context, appId, rule } = {}) {
    const gate = this.#requireSuper(context);
    if (!gate.ok) return gate;
    const id = String(appId == null ? "" : appId);
    const snapshot = this.#snapshot(gate.user);
    if (!snapshot.apps.some((app) => app.id === id)) {
      return this.#fail(DXOS_ERR_NOT_FOUND, "该 APP 当前未安装，无法配置打开权限");
    }
    const normalized = id === "market" ? defaultAppAccessRule(id) : normalizeRule(rule);
    if (normalized.mode === "departments") {
      for (const departmentId of normalized.departmentIds) {
        if (!this.#validDepartment(gate.user.team_id, departmentId)) {
          return this.#fail(DXOS_ERR_INVALID_INPUT, "部门不存在或已停用");
        }
      }
    }
    this.authStore.upsertAppGrant({
      appId: id,
      resourceType: APP_ACCESS_RESOURCE_TYPE,
      scope: ACCESS_SCOPE,
      actions: normalized,
      grantedBy: gate.user.id,
      organizationId: gate.user.team_id,
    });
    this.#audit("app_access.update", { userId: gate.user.id, result: "OK" });
    this.#authzAudit({
      actorUserId: gate.user.id,
      appId: id,
      action: "app_access.update",
      decision: "ALLOW",
      reasonCode: "ALLOW",
      newPermissions: [normalized.mode, ...normalized.departmentIds],
    });
    return { ok: true, rule: normalized };
  }

  /** 源 auth.ts:769-782 saveAppPermissionPolicy。会员门禁（:770）已 OUT。 */
  saveAppPermissionPolicy({ context, permissionCode, policy, appId } = {}) {
    const gate = this.#requireSuper(context);
    if (!gate.ok) return gate;
    const code = String(permissionCode == null ? "" : permissionCode).trim();
    if (!this.#knownPermissionCodes().has(code) && !PERMISSION_CODE_RE.test(code)) {
      return this.#fail(DXOS_ERR_INVALID_INPUT, "不支持的 APP 权限代码");
    }
    const normalized = normalizePolicy(policy);
    for (const departmentId of normalized.departmentIds) {
      if (!this.#validDepartment(gate.user.team_id, departmentId)) {
        return this.#fail(DXOS_ERR_INVALID_INPUT, "部门不存在或已停用");
      }
    }
    for (const userId of normalized.userIds) {
      const target = this.identity.userById(userId);
      if (!target || target.team_id !== gate.user.team_id) {
        return this.#fail(DXOS_ERR_INVALID_INPUT, "权限目标用户不存在");
      }
    }
    // X7：开发者 App 声明的权限码先按清单归到它的安装 appId（dev-<manifest.id>），
    // 再走同一条 appById 存在性校验；host App 的既有校验（含 NOT_FOUND 拒绝）原样保留。
    const hostApp = this.#permissionHostAppId(code) || deriveAppIdOfPermission(code) || (appId ? String(appId) : HOST_APP_ID);
    if (!this.authStore.appById(hostApp)) return this.#fail(DXOS_ERR_NOT_FOUND, "权限宿主 APP 不存在");
    this.authStore.upsertAppGrant({
      appId: hostApp,
      resourceId: code,
      resourceType: APP_PERMISSION_RESOURCE_TYPE,
      scope: ACCESS_SCOPE,
      actions: normalized,
      grantedBy: gate.user.id,
      organizationId: gate.user.team_id,
    });
    this.#audit("app_permission.update", { userId: gate.user.id, result: "OK" });
    this.#authzAudit({
      actorUserId: gate.user.id,
      appId: hostApp,
      action: "app_permission.update",
      decision: "ALLOW",
      reasonCode: "ALLOW",
      newPermissions: [normalized.decision, ...normalized.userIds, ...normalized.departmentIds, ...normalized.roles],
    });
    return { ok: true, policy: normalized };
  }

  /** 便捷读取（非源函数）：内置 + 注入的开发者 App 目录。 */
  listAppCatalog({ context } = {}) {
    const gate = this.#requireSuper(context);
    if (!gate.ok) return gate;
    const catalog = this.#catalog(gate.user);
    return { ok: true, apps: catalog.apps, developerApps: catalog.developerApps };
  }
}

module.exports = {
  LocalAccountService,
  // 纯函数 / 常量（测试与其它批次复用；不重复实现）
  normalizeRule,
  normalizePolicy,
  defaultAppAccessRule,
  ruleAllows,
  deriveAppIdOfPermission,
  APP_ACCESS_RESOURCE_TYPE,
  APP_PERMISSION_RESOURCE_TYPE,
  ACCESS_SCOPE,
  HOST_APP_ID,
  SYSTEM_APP_IDS,
  APP_ACCESS_MODES,
  SYSTEM_ROLES,
  PERMISSION_CODE_RE,
  APP_ACCESS_DENIED,
  AGENT_DEPENDENCY_UNAVAILABLE,
};



