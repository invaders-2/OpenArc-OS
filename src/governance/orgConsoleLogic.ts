"use strict";

/**
 * UI-4 · 组织治理扩展：纯逻辑层（无 React / 无 DOM / 无 I/O）。
 *
 * 为什么单独拆一层：命令白名单、状态映射、错误码→文案、角色/权限展示规则、
 * 审计事件名映射，都是**可离线断言**的规则；放在 .tsx 里就只能在浏览器里测。
 * tests/dxos-org-console.test.mjs 直接 import 这份**界面真正在用**的逻辑。
 *
 * 边界（与 electron/identity-domain.cjs 同口径，界面层不做第二套）：
 *   · 命令白名单逐条对齐 electron/identity-domain.cjs:137-152 的 LOCAL_ACCOUNT_COMMANDS；
 *   · 错误码逐条对齐 identity-domain.cjs:197-208 的 ERROR、
 *     local-account-service.cjs:97-100 的 AGENT_DEPENDENCY_UNAVAILABLE / APP_ACCESS_DENIED、
 *     dxos-foundation-errors.cjs:12-26 的 DXOS_ERR_*；
 *   · 角色三值对齐 local-account-service.cjs:114 的 SYSTEM_ROLES（superadmin/admin/user）；
 *   · APP 打开规则模式对齐 local-account-service.cjs:111 APP_ACCESS_MODES；
 *     权限策略对齐 :112-113 PERMISSION_DECISIONS / DATA_SCOPES；
 *   · 审计事件名沿用源语义（local-account-service.cjs 内 #audit 的字符串）：
 *     department.create / department.update / department.delete / user.create /
 *     user.update / user.delete / user.password.reset / app_access.update /
 *     app_permission.update（:383 :410 :435 :517 :630 :644 :692 :895 :938）。
 *   渲染层自报的**操作者** userId / role / sessionRef 一律不发送：身份由主进程
 *   从当前认证会话反查（identity-service.cjs:320-343）。业务目标 userId 是命令契约
 *   要求的参数（:343-359），不属于"操作者身份"。
 */

/* ══════════════════════════════════════════════════════════════════════════
   1. 命令白名单 —— 界面只能发这 15 条（identity:command 的本地账号命令面；B7f 追加 identity/audit-list）
   ══════════════════════════════════════════════════════════════════════════ */

/** 与 identity-domain.cjs:137-152 逐条、同序对齐。 */
export const ORG_COMMANDS: readonly string[] = [
  "identity/departments-list",
  "identity/department-create",
  "identity/department-update",
  "identity/department-delete",
  "identity/users-list",
  "identity/user-create",
  "identity/user-update",
  "identity/user-delete",
  "identity/user-reset-password",
  "identity/app-access-rule-save",
  "identity/app-permission-policy-save",
  "identity/app-permission-snapshot",
  "identity/app-access-summary",
  "identity/local-account-info",
  "identity/audit-list",
];

/** 未登记命令一律拒绝（不猜、不透传），与 identity-domain.cjs:159-161 同一条判据。 */
export function isAllowedOrgCommand(command: unknown): command is string {
  return typeof command === "string" && ORG_COMMANDS.indexOf(command) >= 0;
}

/** 会改状态的命令：失败要落审计 DENY。 */
export const ORG_MUTATION_COMMANDS: readonly string[] = [
  "identity/department-create",
  "identity/department-update",
  "identity/department-delete",
  "identity/user-create",
  "identity/user-update",
  "identity/user-delete",
  "identity/user-reset-password",
  "identity/app-access-rule-save",
  "identity/app-permission-policy-save",
];

export const ORG_READ_COMMANDS: readonly string[] = [
  "identity/departments-list",
  "identity/users-list",
  "identity/app-permission-snapshot",
  "identity/app-access-summary",
  "identity/local-account-info",
  "identity/audit-list",
];

/* ══════════════════════════════════════════════════════════════════════════
   2. 三个区块
   ══════════════════════════════════════════════════════════════════════════ */

export type OrgSection = "org" | "app" | "audit";
export const ORG_SECTIONS: readonly OrgSection[] = ["org", "app", "audit"];
export const ORG_SECTION_LABEL: Record<OrgSection, string> = {
  org: "组织与成员",
  app: "APP 访问",
  audit: "审计",
};

/* ══════════════════════════════════════════════════════════════════════════
   3. 角色 / 权限展示规则（local-account-service.cjs:114, 242-259）
   ══════════════════════════════════════════════════════════════════════════ */

export type OrgRole = "superadmin" | "admin" | "user";
export const ORG_ROLES: readonly OrgRole[] = ["superadmin", "admin", "user"];
export const ORG_ROLE_LABEL: Record<OrgRole, string> = {
  superadmin: "超级管理员",
  admin: "部门管理员",
  user: "成员",
};

/** 未知角色不猜语义：回落 "user"（#publicUser 的默认分支 :255）。 */
export function normalizeRole(value: unknown): OrgRole {
  return typeof value === "string" && ORG_ROLES.indexOf(value as OrgRole) >= 0
    ? (value as OrgRole)
    : "user";
}

export function roleLabel(value: unknown): string {
  return ORG_ROLE_LABEL[normalizeRole(value)];
}

/**
 * admin 角色必须有部门（local-account-service.cjs:490-495 / :554-556）：
 * 既有两值 role 列用 department-admin 成员关系承载 admin，"没有部门的 admin"无法表达。
 */
export function roleNeedsDepartment(value: unknown): boolean {
  return normalizeRole(value) === "admin";
}

/** 角色能做什么：只陈述真实权限，不给成员暗示未授予的能力。 */
export function rolePrivilegeText(value: unknown): string {
  const role = normalizeRole(value);
  if (role === "superadmin") return "可管理部门、成员与 APP 访问策略";
  if (role === "admin") return "可管理部门内的资源与共享；不能管理账号";
  return "只能使用被授权的 APP 与资源";
}

/** 只有超级管理员能执行治理写操作（local-account-service.cjs:262-269）。 */
export function canManageAccounts(value: unknown): boolean {
  return normalizeRole(value) === "superadmin";
}

/** 角色标签不带色彩区分（DESIGN_SYSTEM §3：同类信息不用色相区分）。 */
export function roleTone(_value: unknown): "neutral" {
  return "neutral";
}

export function userStatusLabel(value: unknown): string {
  const s = typeof value === "string" ? value.toLowerCase() : "";
  if (s === "active") return "已启用";
  if (s === "disabled") return "已禁用";
  return "状态未知";
}

/** 禁用是"需注意"，用 warning；启用用 neutral。 */
export function userStatusTone(value: unknown): "neutral" | "warning" {
  const s = typeof value === "string" ? value.toLowerCase() : "";
  if (s === "disabled") return "warning";
  return "neutral";
}

/* ── APP 打开规则（local-account-service.cjs:111, 124-131）────────────── */

export const ACCESS_MODES: readonly string[] = ["all", "superadmins", "admins", "departments"];
export const ACCESS_MODE_LABEL: Record<string, string> = {
  all: "全部本地账号",
  superadmins: "仅超级管理员",
  admins: "仅部门管理员",
  departments: "指定部门",
};
export function accessModeLabel(value: unknown): string {
  return typeof value === "string" && ACCESS_MODE_LABEL[value] ? ACCESS_MODE_LABEL[value] : "未登记模式";
}

/** 规则的可见摘要；departments 模式必须显示部门数量，不显示不可读的内部 id。 */
export function appRuleSummary(value: unknown): string {
  const rule = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const mode = typeof rule.mode === "string" ? rule.mode : "all";
  if (mode === "departments") {
    const ids = Array.isArray(rule.departmentIds) ? rule.departmentIds : [];
    return "指定部门（" + ids.length + "）";
  }
  return accessModeLabel(mode);
}

/* ── APP 权限策略（local-account-service.cjs:112-115, 133-148）────────── */

export const POLICY_DECISIONS: readonly string[] = ["allow", "deny"];
export const POLICY_DECISION_LABEL: Record<string, string> = { allow: "允许", deny: "拒绝" };
export const DATA_SCOPES: readonly string[] = ["all", "department", "departments", "self", "none"];
export const DATA_SCOPE_LABEL: Record<string, string> = {
  all: "全部数据",
  department: "本部门数据",
  departments: "指定部门数据",
  self: "仅本人数据",
  none: "不授权数据",
};
export function policyDecisionLabel(value: unknown): string {
  return typeof value === "string" && POLICY_DECISION_LABEL[value] ? POLICY_DECISION_LABEL[value] : "拒绝";
}
export function dataScopeLabel(value: unknown): string {
  return typeof value === "string" && DATA_SCOPE_LABEL[value] ? DATA_SCOPE_LABEL[value] : "未声明数据范围";
}

/** 策略摘要：决策 + 目标维度（只报数量，避免把用户 id 显示成人名）。 */
export function policySummary(value: unknown): string {
  const p = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const parts: string[] = [policyDecisionLabel(p.decision)];
  const users = Array.isArray(p.userIds) ? p.userIds.length : 0;
  const depts = Array.isArray(p.departmentIds) ? p.departmentIds.length : 0;
  const roles = Array.isArray(p.roles) ? (p.roles as unknown[]).map((r) => roleLabel(r)) : [];
  if (users) parts.push("用户 " + users);
  if (depts) parts.push("部门 " + depts);
  if (roles.length) parts.push("角色 " + roles.join("/"));
  if (typeof p.dataScope === "string") parts.push(dataScopeLabel(p.dataScope));
  return parts.join(" · ");
}

/* ══════════════════════════════════════════════════════════════════════════
   4. 错误码 → 文案 / PageState（界面只按 code 分支，不解析 message 文本）
   ══════════════════════════════════════════════════════════════════════════ */

export const ORG_ERROR_TEXT: Record<string, string> = {
  // identity-domain.cjs:197-208
  NOT_INITIALIZED: "本机还没有初始化本地账号，请先完成首次设置",
  ALREADY_INITIALIZED: "本机已经初始化过了，不需要重复初始化",
  INVALID_CREDENTIALS: "账号或口令不正确",
  SESSION_EXPIRED: "登录会话已过期，请重新登录",
  SESSION_REVOKED: "登录会话已失效（口令被改或会话被撤销），请重新登录",
  USER_DISABLED: "账号已被禁用，请联系超级管理员",
  LOCKED: "会话已锁定，解锁后可以继续操作",
  RATE_LIMITED: "尝试过于频繁，请稍后再试",
  INTERNAL_ERROR: "身份服务内部错误，操作没有生效",
  INVALID_INPUT: "输入不合法，请检查后重试",
  // local-account-service.cjs:97-100 / :268
  NOT_SUPER_ADMIN: "需要超级管理员权限；当前账号不能执行该治理操作",
  APP_ACCESS_DENIED: "当前账号没有打开该应用的权限",
  AGENT_DEPENDENCY_UNAVAILABLE: "所需依赖尚未接线，操作没有产生任何变更",
  // dxos-foundation-errors.cjs:12-26
  DXOS_ERR_INVALID_INPUT: "输入不合法：部门名至少 2 个字符；admin 角色必须选择部门",
  DXOS_ERR_NOT_FOUND: "目标不存在，可能已被其他操作删除",
  DXOS_ERR_CONFLICT: "与现有数据冲突：部门下仍有资源，或名称 / 用户名重复",
  DXOS_ERR_FORBIDDEN: "当前会话没有权限执行该操作",
  DXOS_ERR_INTERNAL: "本地账号服务内部错误，操作没有生效",
  DXOS_ERR_UNAVAILABLE: "该能力在当前环境不可用",
  DXOS_ERR_DEPENDENCY_MISSING: "缺少必要依赖，操作没有产生任何变更",
  DXOS_ERR_UNSUPPORTED: "当前版本的本地模式不支持该操作",
  DXOS_ERR_TIMEOUT: "操作超时，结果未确认，请核查实际状态",
  DXOS_ERR_CANCELLED: "操作已取消，未产生变更",
  DXOS_ERR_CHILD_FAILED: "子任务失败，本次操作未完成",
  DXOS_ERR_QUOTA_EXCEEDED: "本机配额已用尽，操作未生效",
  DXOS_ERR_QUOTA_LEDGER_MISSING: "缺少本机配额账本，操作未生效",
  DXOS_ERR_SCHEMA_TOO_NEW: "本机数据版本比当前程序新，请勿降级使用",
  // 桥与启动
  NO_BRIDGE: "身份服务未就绪，界面无法派发命令",
  BOOT_FAILED: "身份服务启动失败，请稍后重试",
  ORG_COMMAND_NOT_ALLOWED: "命令不在本地账号白名单内，已拒绝",
};

/** 未登记错误码也给出可读兜底（绝不把原始码或异常文本当正文）。 */
export function orgErrorText(code: unknown): string {
  if (typeof code === "string" && ORG_ERROR_TEXT[code]) return ORG_ERROR_TEXT[code];
  return "组织治理操作失败，请重试";
}

export type OrgPageStateKind = "loading" | "empty" | "error" | "unauthorized" | "unavailable";
export const ORG_PAGE_STATE_KINDS: readonly OrgPageStateKind[] = [
  "loading",
  "empty",
  "error",
  "unauthorized",
  "unavailable",
];

const UNAUTHORIZED_CODES = [
  "SESSION_EXPIRED",
  "SESSION_REVOKED",
  "USER_DISABLED",
  "NOT_INITIALIZED",
  "LOCKED",
  "NOT_SUPER_ADMIN",
  "DXOS_ERR_FORBIDDEN",
  "INVALID_CREDENTIALS",
];
const UNAVAILABLE_CODES = [
  "AGENT_DEPENDENCY_UNAVAILABLE",
  "DXOS_ERR_DEPENDENCY_MISSING",
  "DXOS_ERR_UNAVAILABLE",
  "DXOS_ERR_UNSUPPORTED",
  "NO_BRIDGE",
  "BOOT_FAILED",
];

export function isPermissionError(code: unknown): boolean {
  return typeof code === "string" && UNAUTHORIZED_CODES.indexOf(code) >= 0;
}

/**
 * 只有"确实缺超级管理员权限"才把整页转只读。
 * 会话失效 / 锁定 / 未初始化走 PageState(unauthorized)，不能再叠一条"没有超级管理员权限"，
 * 否则会把"请重新登录"误读成"权限不足"。
 */
export function isManageDenied(code: unknown): boolean {
  return code === "NOT_SUPER_ADMIN" || code === "DXOS_ERR_FORBIDDEN";
}

export function isUnavailableError(code: unknown): boolean {
  return typeof code === "string" && UNAVAILABLE_CODES.indexOf(code) >= 0;
}

/** 错误码 → PageState kind；会话失效 / 越权归 unauthorized，依赖缺失归 unavailable。 */
export function orgErrorState(code: unknown): OrgPageStateKind {
  if (isUnavailableError(code)) return "unavailable";
  if (isPermissionError(code)) return "unauthorized";
  return "error";
}

export type OrgListState = "loading" | "empty" | "error" | "unauthorized" | "unavailable" | "ready";

/**
 * 列表状态优先级：依赖缺失 > 越权 > 错误 > 加载 > 空 > 就绪。
 * 已有缓存数据时不整页盖住（错误 / 加载只作为局部刷新事实）。
 */
export function orgListState(input: {
  loading?: boolean;
  errorCode?: string | null;
  count?: number;
}): OrgListState {
  const count = Number(input && input.count) || 0;
  const errorCode = input && input.errorCode ? input.errorCode : null;
  if (count > 0) return "ready";
  if (errorCode === "AGENT_DEPENDENCY_UNAVAILABLE" || errorCode === "NO_BRIDGE") return "unavailable";
  if (errorCode) return orgErrorState(errorCode);
  if (input && input.loading) return "loading";
  return "empty";
}

export function isEmptyList(count: unknown): boolean {
  const n = Number(count);
  return !Number.isFinite(n) || n <= 0;
}

/* ══════════════════════════════════════════════════════════════════════════
   5. 审计投影：命令 → 源事件名 → audit_log / authorization_audit
   ══════════════════════════════════════════════════════════════════════════ */

export const AUDIT_EVENT_BY_COMMAND: Record<string, string> = {
  "identity/department-create": "department.create",
  "identity/department-update": "department.update",
  "identity/department-delete": "department.delete",
  "identity/user-create": "user.create",
  "identity/user-update": "user.update",
  "identity/user-delete": "user.delete",
  "identity/user-reset-password": "user.password.reset",
  "identity/app-access-rule-save": "app_access.update",
  "identity/app-permission-policy-save": "app_permission.update",
};

/**
 * 每个事件写进哪张审计表：
 *   · #audit → audit_log（identity-store.cjs:158）
 *   · #authzAudit → authorization_audit（仅为带上目标归属的治理动作补写，见文件头映射表）
 */
export const AUDIT_SOURCE_BY_EVENT: Record<string, string[]> = {
  "department.create": ["audit_log"],
  "department.update": ["audit_log"],
  "department.delete": ["audit_log", "authorization_audit"],
  "user.create": ["audit_log"],
  "user.update": ["audit_log"],
  "user.delete": ["audit_log", "authorization_audit"],
  "user.password.reset": ["audit_log"],
  "app_access.update": ["audit_log", "authorization_audit"],
  "app_permission.update": ["audit_log", "authorization_audit"],
};

export function auditEventName(command: unknown): string | null {
  return typeof command === "string" && AUDIT_EVENT_BY_COMMAND[command]
    ? AUDIT_EVENT_BY_COMMAND[command]
    : null;
}

export function auditSources(event: unknown): string[] {
  return typeof event === "string" && AUDIT_SOURCE_BY_EVENT[event]
    ? AUDIT_SOURCE_BY_EVENT[event].slice()
    : [];
}

export type AuditEntry = {
  at: number;
  event: string;
  result: "OK" | "DENY";
  errorCode: string | null;
  sources: string[];
  target: string | null;
  actor: string | null;
};

/**
 * 由一次本地命令结果生成审计投影行（一次动作的确定性投影，不查库）。
 * B7f 起"审计"区块的真实数据源是 identity/audit-list（见 normalizeAuditRow），
 * 这个投影只服务于请求过程中的即时反馈。
 */
export function makeAuditEntry(input: {
  command: unknown;
  ok?: boolean;
  errorCode?: unknown;
  at?: unknown;
  target?: unknown;
  actor?: unknown;
}): AuditEntry | null {
  const event = auditEventName(input && input.command);
  if (!event) return null;
  const at = Number(input.at);
  return {
    at: Number.isFinite(at) && at > 0 ? at : 0,
    event,
    result: input.ok ? "OK" : "DENY",
    errorCode: input.ok ? null : typeof input.errorCode === "string" ? input.errorCode : "DXOS_ERR_INTERNAL",
    sources: auditSources(event),
    target: typeof input.target === "string" && input.target ? input.target : null,
    actor: typeof input.actor === "string" && input.actor ? input.actor : null,
  };
}

/**
 * B7f · 后端审计行 → 界面行。identity/audit-list 返回的字段已去敏：
 *   { at, event, result, errorCode, sources, target, actor }。
 * 不猜缺失来源：后端没给 sources 时回落到本文件的源事件表；都给不出就是空数组。
 */
export function normalizeAuditRow(input: unknown): AuditEntry | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const r = input as Record<string, unknown>;
  const event = typeof r.event === "string" ? r.event : "";
  if (!event) return null;
  const at = Number(r.at);
  const rawSources = Array.isArray(r.sources)
    ? (r.sources as unknown[]).filter((s): s is string => typeof s === "string" && s.length > 0)
    : [];
  return {
    at: Number.isFinite(at) && at > 0 ? at : 0,
    event,
    result: r.result === "DENY" ? "DENY" : "OK",
    errorCode: typeof r.errorCode === "string" && r.errorCode ? r.errorCode : null,
    sources: rawSources.length ? rawSources : auditSources(event),
    target: typeof r.target === "string" && r.target ? r.target : null,
    actor: typeof r.actor === "string" && r.actor ? r.actor : null,
  };
}

/** identity:event 信封（identity-service.cjs:96-106）：{ event, at, ...payload }。 */
export type IdentityEventRow = {
  at: number;
  event: string;
  reason: string | null;
  userId: string | null;
};

export function normalizeIdentityEvent(input: unknown): IdentityEventRow | null {
  if (!input || typeof input !== "object") return null;
  const e = input as Record<string, unknown>;
  if (typeof e.event !== "string" || !e.event) return null;
  const at = Number(e.at);
  return {
    at: Number.isFinite(at) && at > 0 ? at : 0,
    event: e.event,
    reason: typeof e.reason === "string" ? e.reason : null,
    // 只取 userId 用于"是谁"，不取 sessionRef（不把会话句柄带进界面状态）。
    userId: typeof e.userId === "string" ? e.userId : null,
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   6. 命令载荷：按键白名单构造，操作者身份字段永远不出现
   ══════════════════════════════════════════════════════════════════════════ */

/** 每条命令允许出现的载荷键；探针与单测都按它断言（sessionRef / 操作者 role 不在内）。 */
export const ALLOWED_PAYLOAD_KEYS: Record<string, string[]> = {
  "identity/departments-list": [],
  "identity/department-create": ["name", "description"],
  "identity/department-update": ["departmentId", "name", "description", "status"],
  "identity/department-delete": ["departmentId"],
  "identity/users-list": [],
  "identity/user-create": ["identifier", "password", "displayName", "departmentId", "role"],
  "identity/user-update": ["userId", "username", "departmentId", "role", "status"],
  "identity/user-delete": ["userId"],
  "identity/user-reset-password": ["userId", "password"],
  "identity/app-access-rule-save": ["appId", "rule"],
  "identity/app-permission-policy-save": ["permissionCode", "policy", "appId"],
  "identity/app-permission-snapshot": ["userId"],
  "identity/app-access-summary": ["userId"],
  "identity/local-account-info": [],
  "identity/audit-list": ["event", "since", "until", "limit", "offset"],
};

/** 命令结果里的 error 收敛成字符串码：缺失一律 INTERNAL，绝不把 message 文本当码。 */
export function codeOfError(value: unknown): string {
  return typeof value === "string" && value ? value : "DXOS_ERR_INTERNAL";
}

export function payloadKeysAllowed(command: string, payload: unknown): boolean {
  const allowed = ALLOWED_PAYLOAD_KEYS[command];
  if (!allowed) return false;
  if (!payload || typeof payload !== "object") return true;
  return Object.keys(payload as Record<string, unknown>).every((k) => allowed.indexOf(k) >= 0);
}

const trim = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export function departmentCreatePayload(input: { name?: unknown; description?: unknown }): Record<string, unknown> {
  return { name: trim(input && input.name), description: trim(input && input.description) };
}

export function departmentUpdatePayload(input: {
  departmentId?: unknown;
  name?: unknown;
  description?: unknown;
  status?: unknown;
}): Record<string, unknown> {
  const out: Record<string, unknown> = { departmentId: trim(input && input.departmentId), name: trim(input && input.name) };
  const description = trim(input && input.description);
  if (description) out.description = description;
  const status = trim(input && input.status);
  if (status === "active" || status === "disabled") out.status = status;
  return out;
}

export function userCreatePayload(input: {
  identifier?: unknown;
  password?: unknown;
  displayName?: unknown;
  departmentId?: unknown;
  role?: unknown;
}): Record<string, unknown> {
  const out: Record<string, unknown> = {
    identifier: trim(input && input.identifier),
    password: typeof input.password === "string" ? input.password : "",
    displayName: trim(input && input.displayName),
    role: normalizeRole(input && input.role),
  };
  const departmentId = trim(input && input.departmentId);
  if (departmentId) out.departmentId = departmentId;
  return out;
}

export function userUpdatePayload(input: {
  userId?: unknown;
  username?: unknown;
  departmentId?: unknown;
  role?: unknown;
  status?: unknown;
}): Record<string, unknown> {
  const out: Record<string, unknown> = { userId: trim(input && input.userId) };
  const username = trim(input && input.username);
  if (username) out.username = username;
  if (input && input.departmentId !== undefined) out.departmentId = trim(input.departmentId);
  if (input && input.role !== undefined) out.role = normalizeRole(input.role);
  const status = trim(input && input.status);
  if (status === "active" || status === "disabled") out.status = status;
  return out;
}

export function resetPasswordPayload(input: { userId?: unknown; password?: unknown }): Record<string, unknown> {
  return { userId: trim(input && input.userId), password: typeof input.password === "string" ? input.password : "" };
}

export function appAccessRulePayload(input: { appId?: unknown; mode?: unknown; departmentIds?: unknown }): Record<string, unknown> {
  const mode = ACCESS_MODES.indexOf(trim(input && input.mode)) >= 0 ? trim(input.mode) : "all";
  const raw = Array.isArray(input && input.departmentIds) ? (input.departmentIds as unknown[]) : [];
  const departmentIds = mode === "departments" ? raw.map((v) => trim(v)).filter(Boolean) : [];
  return { appId: trim(input && input.appId), rule: { mode, departmentIds } };
}

export function appPermissionPolicyPayload(input: {
  permissionCode?: unknown;
  decision?: unknown;
  roles?: unknown;
  userIds?: unknown;
  departmentIds?: unknown;
  dataScope?: unknown;
}): Record<string, unknown> {
  const policy: Record<string, unknown> = {
    decision: POLICY_DECISIONS.indexOf(trim(input && input.decision)) >= 0 ? trim(input.decision) : "deny",
    userIds: (Array.isArray(input && input.userIds) ? (input.userIds as unknown[]) : []).map(trim).filter(Boolean),
    departmentIds: (Array.isArray(input && input.departmentIds) ? (input.departmentIds as unknown[]) : []).map(trim).filter(Boolean),
    // 与后端 normalizePolicy（local-account-service.cjs:135-138）同一条判据：
    // 未知角色直接丢弃，不 coerce 成 "user"——否则保存策略会凭空多授一个角色。
    roles: (Array.isArray(input && input.roles) ? (input.roles as unknown[]) : [])
      .filter((r) => typeof r === "string" && ORG_ROLES.indexOf(r as OrgRole) >= 0)
      .filter((r, i, arr) => arr.indexOf(r) === i),
  };
  const scope = trim(input && input.dataScope);
  if (DATA_SCOPES.indexOf(scope) >= 0) policy.dataScope = scope;
  return { permissionCode: trim(input && input.permissionCode), policy };
}

/* ══════════════════════════════════════════════════════════════════════════
   7. 展示辅助
   ══════════════════════════════════════════════════════════════════════════ */

/** 访问摘要（app-access-summary.summary: Record<appId, boolean>）→ 稳定顺序的行。 */
export function accessSummaryRows(summary: unknown): Array<{ appId: string; allowed: boolean }> {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) return [];
  return Object.keys(summary as Record<string, unknown>)
    .sort()
    .map((appId) => ({ appId, allowed: (summary as Record<string, unknown>)[appId] === true }));
}

/** 部门视图；无部门用稳定标记，不编造名称。 */
export function departmentName(departments: unknown, departmentId: unknown): string {
  const id = trim(departmentId);
  if (!id) return "未分配部门";
  if (Array.isArray(departments)) {
    const hit = departments.find((d) => d && typeof d === "object" && (d as Record<string, unknown>).id === id);
    if (hit) return String((hit as Record<string, unknown>).name || id);
  }
  return id;
}

/** 按部门筛选成员（成员可属多部门，:253 departmentIds）。 */
export function filterMembers<T extends { departmentIds?: unknown }>(users: T[], departmentId: string | null): T[] {
  if (!departmentId) return users;
  return users.filter((u) => Array.isArray(u.departmentIds) && (u.departmentIds as unknown[]).indexOf(departmentId) >= 0);
}

/** 窄宽阈值与 CSS 容器查询共用 900px。 */
export const ORG_NARROW_MAX = 900;
export function isNarrowLayout(width: number): boolean {
  return Number.isFinite(width) && width <= ORG_NARROW_MAX;
}

/** 会员门禁已 OUT（local-account-service.cjs:40-57）：界面只陈述"本地不限账号数"。 */
export const ORG_LOCAL_MODE_TEXT = "本地模式不限账号数";

export function localAccountSummaryText(info: unknown): string {
  const v = info && typeof info === "object" ? (info as Record<string, unknown>) : {};
  const users = Number(v.userCount);
  const departments = Number(v.departmentCount);
  const u = Number.isFinite(users) ? users : 0;
  const d = Number.isFinite(departments) ? departments : 0;
  return ORG_LOCAL_MODE_TEXT + " · 当前 " + u + " 个账号 / " + d + " 个部门";
}
