/**
 * D3-02 · Object Authorization —— 纯领域模型与策略求值。
 *
 * 与 identity-domain.cjs / window-domain.cjs 同一约束：**纯函数、无 Electron、
 * 无 DOM、无 I/O**，因此能被 node --test 直接覆盖，也能被主进程与探针同时引用。
 *
 * 本模块回答的是 D3-01 之后的第二个问题：
 *
 *   D3-01：你是谁？session 是否有效？
 *   D3-02：当前用户，通过当前 App / Agent Context，
 *          能否对这个逻辑 Resource 执行这个 Action？
 *
 * 授权公式（冻结）：
 *
 *   Effective Resource Access
 *     = Session Valid
 *     AND User Authorized
 *     AND App Authorized
 *     AND Resource Scope Authorized
 *     AND Department Policy Authorized
 *     AND Action Authorized
 *
 * Agent 场景额外要求 resource.useByAgent。
 * 任一项不成立 → DENY；默认 DEFAULT DENY，禁止任何 implicit allow。
 *
 * 三条硬边界：
 *   1. **source（manual / ui / agent / system）只进审计，不参与提权。**
 *      代码里不存在 'if source === "agent" allow'。
 *   2. **Role 只是 Permission Set 的映射。** 业务代码不得用
 *      'if (role === "editor")' 代替动作授权，最终一律调用 authorize()。
 *   3. **Resource 身份是 resourceId / ResourceRef**，不是文件名、路径、
 *      显示名称、窗口标题或数组下标。
 */
"use strict";

const crypto = require("node:crypto");

// ---------------------------------------------------------------------------
// 版本
// ---------------------------------------------------------------------------

/**
 * Policy 版本。第一版采用 DEFAULT DENY + ADDITIVE ALLOW，
 * **不引入** explicit deny / inherit deny precedence。
 * 未来若需要 Explicit Deny，必须升级本版本号，而不是在同版本里悄悄改语义。
 */
const POLICY_VERSION = "d3-02-v1";

// ---------------------------------------------------------------------------
// ID 域
// ---------------------------------------------------------------------------

const ID_PREFIX = Object.freeze({
  DEPARTMENT: "dept_",
  COLLECTION: "col_",
  RESOURCE: "res_",
  APP: "app_",
  GRANT: "grant_",
  MEMBERSHIP: "dmem_",
  AUDIT: "authz_",
});

/** 与 D3-01 的 newId 同一手法：24 字节随机，带域前缀。 */
function newId(kind) {
  const prefix = ID_PREFIX[kind] || "";
  return prefix + crypto.randomBytes(24).toString("base64url");
}

const RESOURCE_ID_PATTERN = /^res_[A-Za-z0-9_-]{4,}$/;
const isResourceId = (v) => typeof v === "string" && RESOURCE_ID_PATTERN.test(v);

/** 概念引用：resource://res_xxx。授权逻辑使用 resourceId，引用只是稳定投影。 */
function toResourceRef(resourceId) {
  if (isResourceId(resourceId)) return "resource://" + resourceId;
  if (typeof resourceId === "string" && resourceId.startsWith("resource://")) return resourceId;
  return null;
}

/** 接受 resource://res_x 或裸 res_x，返回 resourceId 或 null。**不是**路径解析。 */
function parseResourceRef(value) {
  if (typeof value !== "string") return null;
  const raw = value.startsWith("resource://") ? value.slice("resource://".length) : value;
  return isResourceId(raw) ? raw : null;
}

// ---------------------------------------------------------------------------
// Principal
// ---------------------------------------------------------------------------

/**
 * 第一版 Principal：USER / DEPARTMENT / APP。
 * DEVICE 与 SERVICE 属未来扩展（Device 在 D3-03），本轮**不实现**。
 */
const PRINCIPAL = Object.freeze({ USER: "USER", DEPARTMENT: "DEPARTMENT", APP: "APP" });

const MEMBERSHIP_ROLE = Object.freeze({ DEPARTMENT_ADMIN: "department-admin", MEMBER: "member" });
const MEMBERSHIP_STATUS = Object.freeze({ ACTIVE: "ACTIVE", DISABLED: "DISABLED" });

const APP_STATUS = Object.freeze({ ENABLED: "enabled", DISABLED: "disabled" });

// ---------------------------------------------------------------------------
// Resource Scope / Type / Status
// ---------------------------------------------------------------------------

const SCOPE = Object.freeze({
  PERSONAL: "PERSONAL",
  DEPARTMENT: "DEPARTMENT",
  ORGANIZATION: "ORGANIZATION",
});
const ALL_SCOPES = Object.freeze([SCOPE.PERSONAL, SCOPE.DEPARTMENT, SCOPE.ORGANIZATION]);

/** 授权核心必须允许的未来类型；D3-02 只建 Fixture / Registry，不建业务数据。 */
const RESOURCE_TYPES = Object.freeze([
  "memory",
  "text",
  "document",
  "image",
  "video",
  "audio",
  "code",
  "prompt",
  "generated-artifact",
  "file",
  "project",
  "canvas",
  "collection",
  "task",
  "model-config",
  "mcp-connection",
  "skill",
  "app-resource",
  "other",
]);

const RESOURCE_STATUS = Object.freeze({
  ACTIVE: "active",
  DISABLED: "disabled",
  DELETED: "deleted",
});

/** Memory 默认属高敏类型，普通第三方 App 默认 DENY。 */
const SENSITIVE_RESOURCE_TYPES = Object.freeze(["memory"]);

// ---------------------------------------------------------------------------
// Actions 与 Permission Set
// ---------------------------------------------------------------------------

/** Resource Library 动作命名空间。其它 Domain 以后可增加自己的 action namespace。 */
const ACTION = Object.freeze({
  VIEW: "resource.view",
  SEARCH: "resource.search",
  PREVIEW: "resource.preview",
  READ: "resource.read",
  CREATE: "resource.create",
  EDIT: "resource.edit",
  DELETE: "resource.delete",
  RESTORE: "resource.restore",
  PERMANENT_DELETE: "resource.permanentDelete",
  DOWNLOAD: "resource.download",
  EXPORT: "resource.export",
  SHARE: "resource.share",
  TAG: "resource.tag",
  MOVE: "resource.move",
  USE_BY_AGENT: "resource.useByAgent",
  MANAGE_ACCESS: "resource.manageAccess",
});

const RESOURCE_ACTIONS = Object.freeze(Object.values(ACTION));

/**
 * D4-03A · Tool 权限 namespace。与 resource.action 同级，**复用同一 App Principal /
 * App Grant / AuthorizationService**，不是第二权限系统。
 *
 * tool action 有意不被 grantActions() 收集，因此不会参与 Resource 求值、不会意外提权 Resource。
 */
const TOOL_ACTION = Object.freeze({
  TEST_ECHO: "tool.test.echo",
  RESOURCE_READ_METADATA: "tool.resource.readMetadata",
  RESOURCE_SEARCH: "tool.resource.search",
  // D4-03C2：第一条受控真实写入（resource.trash）的 Tool 权限。
  RESOURCE_TRASH: "tool.resource.trash",
});
const TOOL_ACTIONS = Object.freeze(Object.values(TOOL_ACTION));
function isToolAction(action) { return TOOL_ACTIONS.includes(String(action)); }
/** 从 App Grant 的 actions 中只提取 tool actions。*/
function toolGrantActions(grant) {
  if (!grant) return [];
  const raw = grant.actions;
  const list = Array.isArray(raw)
    ? raw
    : (() => { try { const p = JSON.parse(raw || "[]"); return Array.isArray(p) ? p : []; } catch { return []; } })();
  return list.filter((a) => TOOL_ACTIONS.includes(a));
}

/**
 * Permission Set 只是**动作集合的命名映射**。
 *
 * 有意把 resource.useByAgent **排除在所有常规集合之外**：Agent 使用必须单独授予，
 * 不能因为某人是 Editor 就让所有 Agent 自动获得读取能力。
 */
const VIEWER_ACTIONS = Object.freeze([
  ACTION.VIEW,
  ACTION.SEARCH,
  ACTION.PREVIEW,
  ACTION.READ,
  ACTION.DOWNLOAD,
  ACTION.EXPORT,
]);
const CONTRIBUTOR_ACTIONS = Object.freeze([
  ...VIEWER_ACTIONS,
  ACTION.CREATE,
  ACTION.EDIT,
  ACTION.TAG,
  ACTION.MOVE,
]);
const EDITOR_ACTIONS = Object.freeze([...CONTRIBUTOR_ACTIONS, ACTION.DELETE, ACTION.RESTORE, ACTION.SHARE]);
const MANAGER_ACTIONS = Object.freeze([...EDITOR_ACTIONS, ACTION.PERMANENT_DELETE, ACTION.MANAGE_ACCESS]);

const PERMISSION_SET = Object.freeze({
  VIEWER: VIEWER_ACTIONS,
  CONTRIBUTOR: CONTRIBUTOR_ACTIONS,
  EDITOR: EDITOR_ACTIONS,
  MANAGER: MANAGER_ACTIONS,
});

const PERMISSION_SET_NAMES = Object.freeze(Object.keys(PERMISSION_SET));

/**
 * Owner 默认能力（OWNER_POLICY）。这是**显式策略**，
 * 不是"没有 ACL 行 → allow"。探针必须能指出 Allow Source = OWNER_POLICY。
 * owner 对自己的 Personal Resource 拥有全部动作，包含 useByAgent 与 manageAccess。
 */
const OWNER_ACTIONS = Object.freeze([...RESOURCE_ACTIONS]);

/** Organization 成员对 ORGANIZATION scope 资源的基线（ORG_POLICY）。 */
const ORG_POLICY_ACTIONS = Object.freeze([...VIEWER_ACTIONS]);

/** 把 permissionSet 名字展开为动作数组；未知集合返回 null。 */
function expandPermissionSet(name) {
  const key = String(name || "").toUpperCase();
  if (!Object.prototype.hasOwnProperty.call(PERMISSION_SET, key)) return null;
  return [...PERMISSION_SET[key]];
}

/** 把 actions / permissionSet 输入归一为去重后的动作数组。**只接受已知动作。** */
function normalizeGrantActions({ actions, permissionSet } = {}) {
  const out = new Set();
  if (permissionSet != null) {
    const expanded = expandPermissionSet(permissionSet);
    if (!expanded) return null;
    for (const a of expanded) out.add(a);
  }
  if (actions != null) {
    const list = Array.isArray(actions) ? actions : [actions];
    for (const a of list) {
      const act = String(a || "");
      if (!RESOURCE_ACTIONS.includes(act)) return null;
      out.add(act);
    }
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// Governance 动作（Super Admin / Department Admin）
// ---------------------------------------------------------------------------

/**
 * 治理能力也集中在 Policy 中表达，**不写成 'if (admin) allow everything'**。
 * 每个治理动作有自己的判据（Super Admin / Department Admin / 范围）。
 */
const GOVERNANCE_ACTION = Object.freeze({
  VIEW_AUDIT: "governance.viewAudit",
  CREATE_DEPARTMENT: "governance.createDepartment",
  UPDATE_DEPARTMENT: "governance.updateDepartment",
  MANAGE_DEPARTMENT_MEMBER: "governance.manageDepartmentMember",
  CREATE_USER: "governance.createUser",
  SET_USER_STATUS: "governance.setUserStatus",
  SET_USER_ROLE: "governance.setUserRole",
  TRANSFER_OWNERSHIP: "governance.transferOwnership",
  GRANT_RESOURCE_PERMISSION: "governance.grantResourcePermission",
  REVOKE_RESOURCE_PERMISSION: "governance.revokeResourcePermission",
  GRANT_APP_PERMISSION: "governance.grantAppPermission",
  REVOKE_APP_PERMISSION: "governance.revokeAppPermission",
  MANAGE_COLLECTION: "governance.manageCollection",
  REGISTER_APP: "governance.registerApp",
  SET_APP_STATUS: "governance.setAppStatus",
});

/** 只有 Super Admin 可以执行的治理动作；Department Admin 一律 DENY。 */
const SUPER_ADMIN_ONLY = Object.freeze([
  GOVERNANCE_ACTION.CREATE_DEPARTMENT,
  GOVERNANCE_ACTION.UPDATE_DEPARTMENT,
  GOVERNANCE_ACTION.CREATE_USER,
  GOVERNANCE_ACTION.SET_USER_STATUS,
  GOVERNANCE_ACTION.SET_USER_ROLE,
  GOVERNANCE_ACTION.TRANSFER_OWNERSHIP,
  GOVERNANCE_ACTION.GRANT_APP_PERMISSION,
  GOVERNANCE_ACTION.REVOKE_APP_PERMISSION,
  GOVERNANCE_ACTION.REGISTER_APP,
  GOVERNANCE_ACTION.SET_APP_STATUS,
]);

// ---------------------------------------------------------------------------
// Decision / Reason Code
// ---------------------------------------------------------------------------

const DECISION = Object.freeze({ ALLOW: "ALLOW", DENY: "DENY" });

/**
 * 对外 reasonCode。**内部审计可以记真实原因**，
 * 但对外枚举查询必须收敛为 NOT_FOUND_OR_FORBIDDEN，不泄漏对象是否存在。
 */
const REASON = Object.freeze({
  SESSION_REVOKED: "SESSION_REVOKED",
  SESSION_EXPIRED: "SESSION_EXPIRED",
  USER_DISABLED: "USER_DISABLED",
  SESSION_LOCKED: "SESSION_LOCKED",
  SESSION_USER_MISMATCH: "SESSION_USER_MISMATCH",
  APP_REQUIRED: "APP_REQUIRED",
  APP_UNKNOWN: "APP_UNKNOWN",
  APP_DISABLED: "APP_DISABLED",
  APP_ACTION_NOT_GRANTED: "APP_ACTION_NOT_GRANTED",
  APP_TOOL_NOT_GRANTED: "APP_TOOL_NOT_GRANTED",
  TOOL_ACTION_UNKNOWN: "TOOL_ACTION_UNKNOWN",
  APP_PERMISSION_UPGRADE_REQUIRES_APPROVAL: "APP_PERMISSION_UPGRADE_REQUIRES_APPROVAL",
  RESOURCE_NOT_FOUND: "RESOURCE_NOT_FOUND",
  RESOURCE_NOT_AVAILABLE: "RESOURCE_NOT_AVAILABLE",
  NOT_FOUND_OR_FORBIDDEN: "NOT_FOUND_OR_FORBIDDEN",
  ORGANIZATION_DENIED: "ORGANIZATION_DENIED",
  DEPARTMENT_DENIED: "DEPARTMENT_DENIED",
  SCOPE_DENIED: "SCOPE_DENIED",
  USER_ACTION_NOT_GRANTED: "USER_ACTION_NOT_GRANTED",
  ACTION_NOT_GRANTED: "ACTION_NOT_GRANTED",
  DEFAULT_DENY: "DEFAULT_DENY",
  AGENT_USE_NOT_AUTHORIZED: "AGENT_USE_NOT_AUTHORIZED",
  NOT_SUPER_ADMIN: "NOT_SUPER_ADMIN",
  NOT_DEPARTMENT_ADMIN: "NOT_DEPARTMENT_ADMIN",
  CROSS_DEPARTMENT_DENIED: "CROSS_DEPARTMENT_DENIED",
  SELF_ESCALATION_DENIED: "SELF_ESCALATION_DENIED",
  DELEGATION_EXCEEDS_AUTHORITY: "DELEGATION_EXCEEDS_AUTHORITY",
  INVALID_INPUT: "INVALID_INPUT",
  NO_CHANGE: "NO_CHANGE",
  INTERNAL_ERROR: "INTERNAL_ERROR",
});

/** Allow Source：探针据此指出"为什么允许"。 */
const ALLOW_SOURCE = Object.freeze({
  OWNER_POLICY: "OWNER_POLICY",
  USER_GRANT: "USER_GRANT",
  DEPARTMENT_GRANT: "DEPARTMENT_GRANT",
  ORG_POLICY: "ORG_POLICY",
  APP_GRANT: "APP_GRANT",
  SUPER_ADMIN: "SUPER_ADMIN",
  DEPARTMENT_ADMIN: "DEPARTMENT_ADMIN",
});

const ok = (value) => ({ ok: true, ...value });
const fail = (code, detail) => ({ ok: false, error: code, ...(detail ? { detail } : {}) });

// ---------------------------------------------------------------------------
// Source
// ---------------------------------------------------------------------------

/** source 只进 Audit / Diagnostics，**不参与权限提权**。 */
const SOURCE = Object.freeze({ MANUAL: "manual", UI: "ui", AGENT: "agent", SYSTEM: "system" });
const ALL_SOURCES = Object.freeze(Object.values(SOURCE));

function normalizeSource(value) {
  const s = String(value ?? "").trim().toLowerCase();
  return ALL_SOURCES.includes(s) ? s : SOURCE.MANUAL;
}

// ---------------------------------------------------------------------------
// Authorization Context
// ---------------------------------------------------------------------------

/**
 * 统一授权上下文。至少包含 userId / sessionRef / organizationId / departmentIds /
 * appId / agentSessionId nullable / source / requestId。
 */
function normalizeContext(context = {}) {
  const departmentIds = Array.isArray(context.departmentIds)
    ? context.departmentIds.map(String).filter(Boolean)
    : [];
  return {
    userId: context.userId ? String(context.userId) : null,
    sessionRef: context.sessionRef ? String(context.sessionRef) : null,
    organizationId: context.organizationId ? String(context.organizationId) : null,
    teamId: context.teamId ? String(context.teamId) : context.organizationId ? String(context.organizationId) : null,
    departmentIds,
    appId: context.appId ? String(context.appId) : null,
    agentSessionId: context.agentSessionId ? String(context.agentSessionId) : null,
    agent: !!context.agent || !!context.agentSessionId,
    source: normalizeSource(context.source),
    requestId: context.requestId ? String(context.requestId) : null,
  };
}

// ---------------------------------------------------------------------------
// Grant 匹配
// ---------------------------------------------------------------------------

/** grant.actions 在库里是 JSON 文本；容错解析。 */
function grantActions(grant) {
  if (!grant) return [];
  const raw = grant.actions;
  if (Array.isArray(raw)) return raw.filter((a) => RESOURCE_ACTIONS.includes(a));
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed.filter((a) => RESOURCE_ACTIONS.includes(a)) : [];
  } catch {
    return [];
  }
}

const isEmptyTarget = (v) => v == null || v === "";

/**
 * Grant 与 Resource 的匹配：**所有非空目标约束都必须成立**（AND）。
 * 一个目标字段都不填的 grant 是"全局 grant"，对普通资源匹配，
 * 但**对 memory 不成立**（见 appGrantCoversResource）。
 */
function matchGrant(grant, resource) {
  if (!grant || !resource) return false;
  if (!isEmptyTarget(grant.resource_id) && grant.resource_id !== resource.resource_id) return false;
  if (!isEmptyTarget(grant.collection_id) && grant.collection_id !== resource.collection_id) return false;
  if (!isEmptyTarget(grant.resource_type) && grant.resource_type !== resource.resource_type) return false;
  if (!isEmptyTarget(grant.department_id) && grant.department_id !== resource.department_id) return false;
  if (!isEmptyTarget(grant.scope) && grant.scope !== resource.scope) return false;
  return true;
}

const isSensitiveResource = (resource) =>
  !!resource && SENSITIVE_RESOURCE_TYPES.includes(resource.resource_type);

/**
 * App Grant 对高敏资源（memory）的覆盖判定。
 *
 * §25：普通第三方 App 默认 DENY memory；即使拥有 resource.read 也不能自动读取所有 Memory。
 * 因此"全局 grant"（未限定 resource / collection / type）**不覆盖 memory**，
 * 必须显式拥有 Resource Type = memory、单个 Resource 或 Collection Grant。
 */
function appGrantCoversResource(grant, resource) {
  if (isSensitiveResource(resource)) {
    if (isEmptyTarget(grant.resource_id) && isEmptyTarget(grant.collection_id) && isEmptyTarget(grant.resource_type)) {
      return false;
    }
  }
  return matchGrant(grant, resource);
}

// ---------------------------------------------------------------------------
// 策略求值（纯函数）
// ---------------------------------------------------------------------------

const toSet = (arr) => new Set(arr || []);
const addAll = (set, actions) => {
  for (const a of actions) set.add(a);
};

/**
 * 用户侧授权。返回可执行动作集合与来源。
 *
 * 规则（DEFAULT DENY + ADDITIVE ALLOW）：
 *   · owner              → OWNER_POLICY（全部动作）
 *   · 显式 USER grant    → USER_GRANT
 *   · DEPARTMENT grant   → 仅当用户是该部门 ACTIVE 成员，且资源非 PERSONAL
 *   · ORGANIZATION scope → 同组织成员获得 ORG_POLICY 基线（Viewer）
 *
 * Scope 边界：
 *   · 跨组织 → 直接 DENY（organizationId 不信 Renderer 输入，由 Session + Registry 决定）
 *   · DEPARTMENT scope → 必须是该部门 ACTIVE 成员
 *   · PERSONAL         → 只有 owner / 显式 USER grant 生效
 */
function evaluateUserAuthorization({ resource, user, memberships = [], grants = [] }) {
  const result = { actions: new Set(), sources: new Set(), denied: null, isOwner: false };

  if (!user) {
    result.denied = REASON.SESSION_USER_MISMATCH;
    return result;
  }
  if (user.team_id !== resource.organization_id) {
    result.denied = REASON.ORGANIZATION_DENIED;
    return result;
  }

  const activeDeptIds = new Set(
    memberships.filter((m) => m.status === MEMBERSHIP_STATUS.ACTIVE).map((m) => m.department_id),
  );

  if (resource.owner_user_id && resource.owner_user_id === user.id) {
    result.isOwner = true;
    addAll(result.actions, OWNER_ACTIONS);
    result.sources.add(ALLOW_SOURCE.OWNER_POLICY);
  }

  // 显式 USER grant（PERSONAL 也允许显式分享）
  for (const grant of grants) {
    if (grant.principal_type !== PRINCIPAL.USER || grant.principal_id !== user.id) continue;
    if (!matchGrant(grant, resource)) continue;
    const acts = grantActions(grant);
    if (acts.length) {
      addAll(result.actions, acts);
      result.sources.add(ALLOW_SOURCE.USER_GRANT);
    }
  }

  // DEPARTMENT grant：仅对非 PERSONAL 资源、且用户是该部门 ACTIVE 成员
  if (resource.scope !== SCOPE.PERSONAL) {
    for (const grant of grants) {
      if (grant.principal_type !== PRINCIPAL.DEPARTMENT) continue;
      if (!activeDeptIds.has(grant.principal_id)) continue;
      if (!matchGrant(grant, resource)) continue;
      const acts = grantActions(grant);
      if (acts.length) {
        addAll(result.actions, acts);
        result.sources.add(ALLOW_SOURCE.DEPARTMENT_GRANT);
      }
    }
  }

  // ORGANIZATION scope 基线：同组织成员获得 Viewer
  if (resource.scope === SCOPE.ORGANIZATION) {
    addAll(result.actions, ORG_POLICY_ACTIONS);
    result.sources.add(ALLOW_SOURCE.ORG_POLICY);
  }

  // Scope 边界
  if (resource.scope === SCOPE.DEPARTMENT && !activeDeptIds.has(resource.department_id)) {
    result.denied = REASON.DEPARTMENT_DENIED;
  }
  if (resource.scope === SCOPE.PERSONAL && !result.isOwner && !result.sources.has(ALLOW_SOURCE.USER_GRANT)) {
    result.denied = REASON.SCOPE_DENIED;
  }
  return result;
}

/** App 侧授权。App 默认 DENY；高敏资源要求显式 Resource / Collection / Type grant。 */
function evaluateAppAuthorization({ resource, app, grants = [] }) {
  const result = { actions: new Set(), sources: new Set(), denied: null };
  if (!app) {
    result.denied = REASON.APP_REQUIRED;
    return result;
  }
  const status = String(app.status || "").toLowerCase();
  if (status !== APP_STATUS.ENABLED) {
    result.denied = REASON.APP_DISABLED;
    return result;
  }
  for (const grant of grants) {
    if (grant.app_id !== app.app_id) continue;
    if (!appGrantCoversResource(grant, resource)) continue;
    const acts = grantActions(grant);
    if (acts.length) {
      addAll(result.actions, acts);
      result.sources.add(ALLOW_SOURCE.APP_GRANT);
    }
  }
  return result;
}

/**
 * 最终策略求值。会话闸门与 App Principal 存在性由 Service 预检；
 * 这里做 User ∩ App ∩ Scope ∩ Department ∩ Action，Agent 再要求 useByAgent。
 *
 * @returns { decision, reasonCode, effectivePermissions, userActions, appActions, allowSources }
 */
function evaluatePolicy({ resource, user, memberships = [], grants = [], app, appGrants = [], action, agent = false, allowInactiveResource = false }) {
  const deny = (reasonCode, extra = {}) => ({
    decision: DECISION.DENY,
    reasonCode,
    effectivePermissions: [],
    userActions: [],
    appActions: [],
    allowSources: [],
    ...extra,
  });

  // §46：生命周期动作（restore / permanentDelete）需要能在 trashed 资源上重新求值。
  // 普通调用方不传这个开关，默认仍是 DEFAULT DENY。
  if (!resource || (resource.status !== RESOURCE_STATUS.ACTIVE && !allowInactiveResource)) {
    return deny(REASON.RESOURCE_NOT_AVAILABLE);
  }

  const userResult = evaluateUserAuthorization({ resource, user, memberships, grants });
  if (userResult.denied) return deny(userResult.denied);

  const appResult = evaluateAppAuthorization({ resource, app, grants: appGrants });
  if (appResult.denied) return deny(appResult.denied);

  const effective = new Set([...userResult.actions].filter((a) => appResult.actions.has(a)));

  // Agent：必须独立拥有 resource.useByAgent（在 User 侧显式授予或 OWNER_POLICY）
  if (agent && !userResult.actions.has(ACTION.USE_BY_AGENT)) {
    return deny(REASON.AGENT_USE_NOT_AUTHORIZED);
  }

  if (!userResult.actions.has(action)) {
    return deny(REASON.USER_ACTION_NOT_GRANTED);
  }
  if (!appResult.actions.has(action)) {
    return deny(REASON.APP_ACTION_NOT_GRANTED);
  }
  if (!effective.has(action)) {
    // 理论上不可达（两个集合都含 action ⇒ 交集也含）；保留作为一致性断言。
    return deny(REASON.DEFAULT_DENY);
  }

  const allowSources = [...new Set([...userResult.sources, ...appResult.sources])];
  return {
    decision: DECISION.ALLOW,
    reasonCode: "ALLOW",
    effectivePermissions: [...effective].sort(),
    userActions: [...userResult.actions].sort(),
    appActions: [...appResult.actions].sort(),
    allowSources,
  };
}

// ---------------------------------------------------------------------------
// Delegation Ceiling
// ---------------------------------------------------------------------------

/**
 * 授权动作必须满足：
 *   grantorCanManage(target) AND grantorEffectivePermissions ⊇ permissionsBeingGranted
 * 否则 DELEGATION_EXCEEDS_AUTHORITY。
 */
function evaluateDelegation({ grantorActions = [], actionsBeingGranted = [], grantorCanManage = false }) {
  // 不能管理目标本身也是在授予自己无权授予的东西 —— 与"超出权限"同码。
  if (!grantorCanManage) return fail(REASON.DELEGATION_EXCEEDS_AUTHORITY);
  const have = toSet(grantorActions);
  const missing = (actionsBeingGranted || []).filter((a) => !have.has(a));
  if (missing.length) return { ok: false, error: REASON.DELEGATION_EXCEEDS_AUTHORITY, missing };
  return ok({ missing: [] });
}

/** 自我提权：principal === grantor 且授予的动作不是当前已拥有动作的子集。 */
function evaluateSelfEscalation({ grantorUserId, principalType, principalId, actionsBeingGranted = [], grantorActions = [] }) {
  if (principalType !== PRINCIPAL.USER || principalId !== grantorUserId) return ok({ self: false });
  const have = toSet(grantorActions);
  const missing = actionsBeingGranted.filter((a) => !have.has(a));
  if (missing.length) return { ok: false, error: REASON.SELF_ESCALATION_DENIED, missing };
  return ok({ self: true, missing: [] });
}

// ---------------------------------------------------------------------------
// App 权限升级 contract（§49）
// ---------------------------------------------------------------------------

/**
 * App 更新若把权限从 read 扩到 read + delete：**必须重新批准**，不能静默继承。
 * 真正安装更新属 D5，这里只表达 contract。
 */
function evaluateAppPermissionUpgrade({ currentActions = [], requestedActions = [] }) {
  const cur = toSet(currentActions);
  const added = (requestedActions || []).filter((a) => !cur.has(a));
  return {
    requiresReapproval: added.length > 0,
    added,
    reasonCode: added.length ? REASON.APP_PERMISSION_UPGRADE_REQUIRES_APPROVAL : "NO_CHANGE",
  };
}

// ---------------------------------------------------------------------------
// 外部错误收敛
// ---------------------------------------------------------------------------

/**
 * 无权用户枚举 resourceId 时，对外只能是 NOT_FOUND_OR_FORBIDDEN；
 * 真实原因只进内部 Audit。**不泄漏** name / owner / path / description /
 * thumbnail / tag / collection / size / resourceType。
 */
function externalReason(reasonCode) {
  if (reasonCode === REASON.RESOURCE_NOT_FOUND) return REASON.NOT_FOUND_OR_FORBIDDEN;
  if (reasonCode === REASON.RESOURCE_NOT_AVAILABLE) return REASON.NOT_FOUND_OR_FORBIDDEN;
  return reasonCode;
}

// ---------------------------------------------------------------------------
// Capability Projection（§61）
// ---------------------------------------------------------------------------

const CAPABILITY_ACTIONS = Object.freeze({
  canView: ACTION.VIEW,
  canSearch: ACTION.SEARCH,
  canPreview: ACTION.PREVIEW,
  canRead: ACTION.READ,
  canCreate: ACTION.CREATE,
  canEdit: ACTION.EDIT,
  canDelete: ACTION.DELETE,
  canRestore: ACTION.RESTORE,
  canPermanentDelete: ACTION.PERMANENT_DELETE,
  canDownload: ACTION.DOWNLOAD,
  canExport: ACTION.EXPORT,
  canShare: ACTION.SHARE,
  canTag: ACTION.TAG,
  canMove: ACTION.MOVE,
  canUseByAgent: ACTION.USE_BY_AGENT,
  canManageAccess: ACTION.MANAGE_ACCESS,
});

// ---------------------------------------------------------------------------
// 输入校验
// ---------------------------------------------------------------------------

function validateResourceType(type) {
  if (!RESOURCE_TYPES.includes(String(type || ""))) return fail(REASON.INVALID_INPUT, "resource-type-unknown");
  return ok({ resourceType: String(type) });
}

function validateScope(scope) {
  if (!ALL_SCOPES.includes(String(scope || ""))) return fail(REASON.INVALID_INPUT, "scope-unknown");
  return ok({ scope: String(scope) });
}

module.exports = {
  POLICY_VERSION,
  ID_PREFIX,
  PRINCIPAL,
  MEMBERSHIP_ROLE,
  MEMBERSHIP_STATUS,
  APP_STATUS,
  SCOPE,
  ALL_SCOPES,
  RESOURCE_TYPES,
  RESOURCE_STATUS,
  SENSITIVE_RESOURCE_TYPES,
  ACTION,
  RESOURCE_ACTIONS,
  TOOL_ACTION,
  TOOL_ACTIONS,
  isToolAction,
  toolGrantActions,
  PERMISSION_SET,
  PERMISSION_SET_NAMES,
  OWNER_ACTIONS,
  ORG_POLICY_ACTIONS,
  GOVERNANCE_ACTION,
  SUPER_ADMIN_ONLY,
  DECISION,
  REASON,
  ALLOW_SOURCE,
  SOURCE,
  ALL_SOURCES,
  CAPABILITY_ACTIONS,
  newId,
  isResourceId,
  toResourceRef,
  parseResourceRef,
  expandPermissionSet,
  normalizeGrantActions,
  normalizeSource,
  normalizeContext,
  grantActions,
  matchGrant,
  isSensitiveResource,
  appGrantCoversResource,
  evaluateUserAuthorization,
  evaluateAppAuthorization,
  evaluatePolicy,
  evaluateDelegation,
  evaluateSelfEscalation,
  evaluateAppPermissionUpgrade,
  externalReason,
  validateResourceType,
  validateScope,
  ok,
  fail,
};
