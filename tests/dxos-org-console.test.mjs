/**
 * UI-4 · 组织治理扩展契约单测（纯逻辑，不启动浏览器、不依赖 DOM 渲染库）。
 *
 * 测的是 src/governance/orgConsoleLogic.ts 这一份**界面真正在用**的规则：
 *   · 命令白名单逐条等于 electron/identity-domain.cjs 的 LOCAL_ACCOUNT_COMMANDS（含顺序）
 *   · 读写分区等于后端的 risk 表（read vs manage/destructive）
 *   · 错误码 → 文案 / PageState 覆盖后端全部 identity / local-account / DXOS_ERR 码
 *   · 角色 / 权限展示规则（三值角色、admin 必须有部门、只读角色）
 *   · 审计事件名沿用源语义，来源表标对 audit_log / authorization_audit
 *   · 命令载荷按键白名单构造，操作者身份字段永不出现
 *   · 界面源码边界（不 fetch、不写 localStorage、不直连端口、不出现会员字样）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import {
  ACCESS_MODES,
  ALLOWED_PAYLOAD_KEYS,
  AUDIT_EVENT_BY_COMMAND,
  AUDIT_SOURCE_BY_EVENT,
  DATA_SCOPES,
  ORG_COMMANDS,
  ORG_MUTATION_COMMANDS,
  ORG_PAGE_STATE_KINDS,
  ORG_READ_COMMANDS,
  ORG_ROLE_LABEL,
  ORG_ROLES,
  ORG_SECTIONS,
  ORG_SECTION_LABEL,
  ORG_ERROR_TEXT,
  ORG_LOCAL_MODE_TEXT,
  ORG_NARROW_MAX,
  POLICY_DECISIONS,
  accessModeLabel,
  accessSummaryRows,
  appAccessRulePayload,
  appPermissionPolicyPayload,
  appRuleSummary,
  auditEventName,
  auditSources,
  canManageAccounts,
  codeOfError,
  dataScopeLabel,
  departmentCreatePayload,
  departmentName,
  departmentUpdatePayload,
  filterMembers,
  isEmptyList,
  isAllowedOrgCommand,
  isManageDenied,
  isNarrowLayout,
  isPermissionError,
  isUnavailableError,
  localAccountSummaryText,
  makeAuditEntry,
  normalizeAuditRow,
  normalizeIdentityEvent,
  normalizeRole,
  orgErrorState,
  orgErrorText,
  orgListState,
  payloadKeysAllowed,
  policySummary,
  resetPasswordPayload,
  roleLabel,
  roleNeedsDepartment,
  rolePrivilegeText,
  userCreatePayload,
  userStatusLabel,
  userStatusTone,
  userUpdatePayload,
} from "../src/governance/orgConsoleLogic.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const require = createRequire(import.meta.url);
const domain = require(path.join(ROOT, "electron", "identity-domain.cjs"));
const foundationErrors = require(path.join(ROOT, "electron", "dxos-foundation-errors.cjs"));

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|\s)\/\/[^\n]*/g, "$1");

/* ══════════════════════════════════════════════════════════════════════════
   1 命令白名单：界面白名单 == 后端本地账号命令表
   ══════════════════════════════════════════════════════════════════════════ */
test("命令白名单逐条等于后端 identity-domain.cjs 的 LOCAL_ACCOUNT_COMMANDS（含顺序与条数）", () => {
  const backend = domain.LOCAL_ACCOUNT_COMMAND_NAMES;
  assert.equal(backend.length, 15, "后端应有 15 条本地账号命令（B7f 追加 identity/audit-list）");
  assert.deepEqual([...ORG_COMMANDS], [...backend], "界面白名单必须与后端完全一致，不能多也不能少");
});

test("白名单命令都是 identity/ 前缀且不重复", () => {
  const set = new Set(ORG_COMMANDS);
  assert.equal(set.size, ORG_COMMANDS.length, "白名单不能有重复项");
  for (const c of ORG_COMMANDS) {
    assert.match(c, /^identity\/[a-z-]+$/, c + " 必须是 identity/ 前缀命令");
    assert.equal(domain.isLocalAccountCommand(c), true, c + " 必须是后端承认的命令");
  }
});

test("isAllowedOrgCommand 拒绝非白名单输入（含原型污染与非法类型）", () => {
  for (const bad of ["", "identity/unknown", "identity/departments-list ", "IDENTITY/DEPARTMENTS-LIST", "__proto__", "constructor", "toString", undefined, null, 42, {}, []]) {
    assert.equal(isAllowedOrgCommand(bad), false, JSON.stringify(bad) + " 必须被拒绝");
  }
  assert.equal(isAllowedOrgCommand("identity/users-list"), true);
});

test("读写分区等于后端 risk 表：read 进只读集，manage/destructive 进写集", () => {
  const readByRisk = [];
  const writeByRisk = [];
  for (const entry of domain.listLocalAccountCommands()) {
    if (entry.risk === "read") readByRisk.push(entry.command);
    else writeByRisk.push(entry.command);
  }
  assert.deepEqual([...ORG_READ_COMMANDS].sort(), readByRisk.sort(), "只读集必须等于 risk=read");
  assert.deepEqual([...ORG_MUTATION_COMMANDS].sort(), writeByRisk.sort(), "写集必须等于 manage/destructive");
  const union = [...ORG_READ_COMMANDS, ...ORG_MUTATION_COMMANDS].sort();
  assert.deepEqual(union, [...ORG_COMMANDS].sort(), "读写两集必须刚好分区全部命令");
});

/* ══════════════════════════════════════════════════════════════════════════
   2 三区块
   ══════════════════════════════════════════════════════════════════════════ */
test("三个区块标签固定且不出现会员语义", () => {
  assert.deepEqual([...ORG_SECTIONS], ["org", "app", "audit"]);
  assert.deepEqual(
    ORG_SECTIONS.map((s) => ORG_SECTION_LABEL[s]),
    ["组织与成员", "APP 访问", "审计"],
  );
  for (const label of Object.values(ORG_SECTION_LABEL)) {
    assert.equal(/(会员|权益|套餐|积分)/.test(label), false, label);
  }
});

/* ══════════════════════════════════════════════════════════════════════════
   3 角色 / 权限展示规则
   ══════════════════════════════════════════════════════════════════════════ */
test("三值角色逐条对齐后端 SYSTEM_ROLES，且未知角色回落成员", () => {
  assert.deepEqual([...ORG_ROLES], ["superadmin", "admin", "user"]);
  assert.equal(ORG_ROLE_LABEL.superadmin, "超级管理员");
  assert.equal(ORG_ROLE_LABEL.admin, "部门管理员");
  assert.equal(ORG_ROLE_LABEL.user, "成员");
  assert.equal(normalizeRole("superadmin"), "superadmin");
  for (const bad of ["SUPERADMIN", "owner", "", null, undefined, 42, {}]) {
    assert.equal(normalizeRole(bad), "user", JSON.stringify(bad) + " 必须回落 user（不猜语义）");
  }
});

test("只有超级管理员能管理账号；admin 必须有部门", () => {
  assert.equal(canManageAccounts("superadmin"), true);
  assert.equal(canManageAccounts("admin"), false, "部门管理员不能管理账号");
  assert.equal(canManageAccounts("user"), false);
  assert.equal(roleNeedsDepartment("admin"), true, "admin 需要部门（department-admin 成员关系承载）");
  assert.equal(roleNeedsDepartment("superadmin"), false);
  assert.equal(roleNeedsDepartment("user"), false);
});

test("角色能力文案只陈述真实权限，三种角色互不相同", () => {
  const texts = ORG_ROLES.map((r) => rolePrivilegeText(r));
  assert.equal(new Set(texts).size, 3, "三种角色的能力文案必须彼此不同");
  assert.ok(rolePrivilegeText("superadmin").includes("部门"));
  assert.ok(rolePrivilegeText("admin").includes("不能管理账号"));
  assert.ok(rolePrivilegeText("user").includes("被授权"));
  for (const t of texts) assert.equal(/(会员|权益|套餐)/.test(t), false, t);
});

test("用户状态展示：active/disabled 有中文与语气，未知不猜", () => {
  assert.equal(userStatusLabel("active"), "已启用");
  assert.equal(userStatusLabel("disabled"), "已禁用");
  assert.equal(userStatusLabel("weird"), "状态未知");
  assert.equal(userStatusTone("disabled"), "warning");
  assert.equal(userStatusTone("active"), "neutral");
  assert.equal(userStatusTone("weird"), "neutral");
});

test("APP 打开模式 / 权限策略展示对齐后端常量", () => {
  assert.deepEqual([...ACCESS_MODES], ["all", "superadmins", "admins", "departments"]);
  assert.deepEqual([...POLICY_DECISIONS], ["allow", "deny"]);
  assert.deepEqual([...DATA_SCOPES], ["all", "department", "departments", "self", "none"]);
  assert.equal(accessModeLabel("all"), "全部本地账号");
  assert.equal(accessModeLabel("nope"), "未登记模式");
  assert.equal(dataScopeLabel("department"), "本部门数据");
  assert.equal(appRuleSummary({ mode: "departments", departmentIds: ["a", "b"] }), "指定部门（2）");
  assert.equal(appRuleSummary({ mode: "admins", departmentIds: [] }), "仅部门管理员");
  assert.equal(appRuleSummary(null), "全部本地账号");
  assert.equal(policySummary({ decision: "allow", userIds: ["u"], roles: ["admin"], dataScope: "department" }), "允许 · 用户 1 · 角色 部门管理员 · 本部门数据");
  assert.equal(policySummary({}), "拒绝");
});

/* ══════════════════════════════════════════════════════════════════════════
   4 错误码 → 文案 / PageState
   ══════════════════════════════════════════════════════════════════════════ */
test("后端每个 identity ERROR 码都有非兜底的人话文案", () => {
  for (const code of Object.values(domain.ERROR)) {
    const text = orgErrorText(code);
    assert.equal(text, ORG_ERROR_TEXT[code], code + " 必须逐条登记，不能落兜底");
    assert.ok(text.length > 0);
  }
});

test("后端每个 DXOS_ERR 码都有非兜底的人话文案", () => {
  for (const code of foundationErrors.DXOS_ERROR_CODES) {
    assert.equal(orgErrorText(code), ORG_ERROR_TEXT[code], code + " 必须逐条登记");
  }
});

test("本地账号服务 / 桥 / 越权码都有登记", () => {
  for (const code of ["NOT_SUPER_ADMIN", "APP_ACCESS_DENIED", "AGENT_DEPENDENCY_UNAVAILABLE", "NO_BRIDGE", "BOOT_FAILED", "ORG_COMMAND_NOT_ALLOWED"]) {
    assert.ok(ORG_ERROR_TEXT[code], code + " 必须登记");
    assert.notEqual(orgErrorText(code), "组织治理操作失败，请重试");
  }
  assert.equal(orgErrorText("SOMETHING_NEW"), "组织治理操作失败，请重试");
  assert.equal(codeOfError(undefined), "DXOS_ERR_INTERNAL");
  assert.equal(codeOfError("SESSION_EXPIRED"), "SESSION_EXPIRED");
});

test("错误码 → PageState kind：会话失效 / 越权归 unauthorized，依赖缺失归 unavailable", () => {
  assert.equal(orgErrorState("SESSION_EXPIRED"), "unauthorized");
  assert.equal(orgErrorState("SESSION_REVOKED"), "unauthorized");
  assert.equal(orgErrorState("NOT_SUPER_ADMIN"), "unauthorized");
  assert.equal(orgErrorState("DXOS_ERR_FORBIDDEN"), "unauthorized");
  assert.equal(orgErrorState("LOCKED"), "unauthorized");
  assert.equal(orgErrorState("AGENT_DEPENDENCY_UNAVAILABLE"), "unavailable");
  assert.equal(orgErrorState("NO_BRIDGE"), "unavailable");
  assert.equal(orgErrorState("DXOS_ERR_DEPENDENCY_MISSING"), "unavailable");
  assert.equal(orgErrorState("DXOS_ERR_INVALID_INPUT"), "error");
  for (const code of [...Object.values(domain.ERROR), ...foundationErrors.DXOS_ERROR_CODES]) {
    assert.equal(ORG_PAGE_STATE_KINDS.indexOf(orgErrorState(code)) >= 0, true, code);
  }
  assert.equal(isPermissionError("NOT_SUPER_ADMIN"), true);
  assert.equal(isUnavailableError("AGENT_DEPENDENCY_UNAVAILABLE"), true);
  assert.equal(isPermissionError("DXOS_ERR_INVALID_INPUT"), false);
  /* 只有"确实缺超级管理员权限"才把整页转只读；会话失效不能叠这条横幅。 */
  assert.equal(isManageDenied("NOT_SUPER_ADMIN"), true);
  assert.equal(isManageDenied("DXOS_ERR_FORBIDDEN"), true);
  assert.equal(isManageDenied("SESSION_EXPIRED"), false);
  assert.equal(isManageDenied("LOCKED"), false);
  assert.equal(isManageDenied("DXOS_ERR_INTERNAL"), false);
});

test("列表状态优先级：依赖缺失 > 越权 > 错误 > 加载 > 空 > 就绪（有缓存不整页盖住）", () => {
  const base = { loading: false, errorCode: null, count: 0 };
  assert.equal(orgListState({ ...base, errorCode: "AGENT_DEPENDENCY_UNAVAILABLE", loading: true }), "unavailable");
  assert.equal(orgListState({ ...base, errorCode: "NO_BRIDGE" }), "unavailable");
  assert.equal(orgListState({ ...base, errorCode: "NOT_SUPER_ADMIN" }), "unauthorized");
  assert.equal(orgListState({ ...base, errorCode: "DXOS_ERR_INTERNAL" }), "error");
  assert.equal(orgListState({ ...base, loading: true }), "loading");
  assert.equal(orgListState(base), "empty");
  assert.equal(orgListState({ ...base, count: 3 }), "ready");
  assert.equal(orgListState({ ...base, errorCode: "DXOS_ERR_INTERNAL", count: 3 }), "ready");
  assert.equal(orgListState({ ...base, loading: true, count: 3 }), "ready");
});

test("空态判定：0 或非法都算空；窄宽阈值与 CSS 容器查询共用 900px", () => {
  assert.equal(isEmptyList(0), true);
  assert.equal(isEmptyList(-1), true);
  assert.equal(isEmptyList(NaN), true);
  assert.equal(isEmptyList(1), false);
  assert.equal(ORG_NARROW_MAX, 900);
  assert.equal(isNarrowLayout(640), true);
  assert.equal(isNarrowLayout(900), true);
  assert.equal(isNarrowLayout(901), false);
  const css = read("src/styles.css");
  assert.ok(css.indexOf("@container (max-width: 900px)") >= 0, "CSS 容器查询阈值必须仍是 900px");
  assert.ok(css.indexOf(".org-split") >= 0, "窄宽规则必须覆盖 .org-split");
});

/* ══════════════════════════════════════════════════════════════════════════
   5 审计事件名映射
   ══════════════════════════════════════════════════════════════════════════ */
test("审计事件名沿用源语义：命令 → 源事件名逐一登记", () => {
  const expected = {
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
  assert.deepEqual(AUDIT_EVENT_BY_COMMAND, expected);
  for (const [command, event] of Object.entries(expected)) {
    assert.equal(auditEventName(command), event);
    /* 源事件名字面量必须真的出现在后端服务的 #audit(...) 调用里。 */
    const source = read("electron/local-account-service.cjs");
    assert.ok(source.indexOf('"' + event + '"') >= 0, event + " 必须出现在 local-account-service.cjs 里");
  }
  assert.equal(auditEventName("identity/users-list"), null, "只读命令不落审计");
});

test("审计来源表：删除与 APP 策略同时写 audit_log 与 authorization_audit", () => {
  assert.deepEqual(auditSources("department.create"), ["audit_log"]);
  assert.deepEqual(auditSources("department.delete"), ["audit_log", "authorization_audit"]);
  assert.deepEqual(auditSources("user.delete"), ["audit_log", "authorization_audit"]);
  assert.deepEqual(auditSources("app_access.update"), ["audit_log", "authorization_audit"]);
  assert.deepEqual(auditSources("user.password.reset"), ["audit_log"]);
  assert.deepEqual(auditSources("nope"), []);
  assert.equal(Object.keys(AUDIT_SOURCE_BY_EVENT).length, 9);
  for (const event of Object.keys(AUDIT_EVENT_BY_COMMAND).map((c) => AUDIT_EVENT_BY_COMMAND[c])) {
    assert.ok(AUDIT_SOURCE_BY_EVENT[event], event + " 必须有来源表登记");
  }
});

test("makeAuditEntry 由命令结果生成 OK / DENY 行，只读命令返回 null", () => {
  const ok = makeAuditEntry({ command: "identity/department-create", ok: true, at: 1700000000000, target: "运营部" });
  assert.deepEqual(ok, {
    at: 1700000000000,
    event: "department.create",
    result: "OK",
    errorCode: null,
    sources: ["audit_log"],
    target: "运营部",
    actor: null,
  });
  const deny = makeAuditEntry({ command: "identity/user-create", ok: false, errorCode: "DXOS_ERR_INVALID_INPUT", at: 1 });
  assert.equal(deny.result, "DENY");
  assert.equal(deny.errorCode, "DXOS_ERR_INVALID_INPUT");
  assert.equal(deny.target, null);
  assert.equal(makeAuditEntry({ command: "identity/users-list", ok: true }), null);
});

test("B7f normalizeAuditRow：后端去敏行 → 界面行，缺 event 丢弃，来源缺失回落源事件表", () => {
  const row = normalizeAuditRow({ at: 1700000000000, event: "department.create", result: "OK", sources: ["audit_log"], target: "运营部", actor: "usr_admin" });
  assert.deepEqual(row, { at: 1700000000000, event: "department.create", result: "OK", errorCode: null, sources: ["audit_log"], target: "运营部", actor: "usr_admin" });
  const deny = normalizeAuditRow({ at: 1, event: "app_access.update", result: "DENY", errorCode: "DXOS_ERR_FORBIDDEN" });
  assert.equal(deny.result, "DENY");
  assert.equal(deny.errorCode, "DXOS_ERR_FORBIDDEN");
  assert.deepEqual(deny.sources, ["audit_log", "authorization_audit"], "缺 sources 时回落源事件表");
  assert.equal(normalizeAuditRow({ at: 1 }), null);
  assert.equal(normalizeAuditRow(null), null);
  assert.equal(normalizeAuditRow("x"), null);
  assert.equal(normalizeAuditRow({ event: "auth.login" }).sources.length, 0, "未知事件不编造来源表");
});

test("identity:event 信封规范化只取 event/at/reason/userId，不带 sessionRef", () => {
  const row = normalizeIdentityEvent({ event: "identity/session-changed", at: 100, reason: "login", userId: "usr_1", sessionRef: "sref_leak" });
  assert.deepEqual(row, { at: 100, event: "identity/session-changed", reason: "login", userId: "usr_1" });
  assert.equal(Object.prototype.hasOwnProperty.call(row, "sessionRef"), false);
  assert.equal(normalizeIdentityEvent({ at: 1 }), null);
  assert.equal(normalizeIdentityEvent(null), null);
  assert.equal(normalizeIdentityEvent({ event: "identity/locked" }).at, 0);
});

/* ══════════════════════════════════════════════════════════════════════════
   6 命令载荷：按键白名单构造，操作者身份字段永不出现
   ══════════════════════════════════════════════════════════════════════════ */
test("ALLOWED_PAYLOAD_KEYS 覆盖全部命令且不含 sessionRef / 操作者 role", () => {
  assert.deepEqual(Object.keys(ALLOWED_PAYLOAD_KEYS).sort(), [...ORG_COMMANDS].sort());
  for (const [command, keys] of Object.entries(ALLOWED_PAYLOAD_KEYS)) {
    assert.ok(Array.isArray(keys), command);
    for (const forbidden of ["sessionRef", "sessionId", "token", "passwordHash"]) {
      assert.equal(keys.indexOf(forbidden), -1, command + " 不得允许 " + forbidden);
    }
  }
  assert.equal(payloadKeysAllowed("identity/user-create", { identifier: "a", password: "b", displayName: "c", departmentId: "d", role: "admin" }), true);
  assert.equal(payloadKeysAllowed("identity/user-create", { identifier: "a", sessionRef: "x" }), false);
  assert.equal(payloadKeysAllowed("identity/unknown", {}), false);
});

test("user-create 载荷：admin 无部门时构造出不带 departmentId 的载荷（后端据此回 DXOS_ERR_INVALID_INPUT）", () => {
  const adminNoDept = userCreatePayload({ identifier: " admin ", password: "password1", displayName: "管理员", role: "admin", departmentId: "" });
  assert.deepEqual(adminNoDept, { identifier: "admin", password: "password1", displayName: "管理员", role: "admin" });
  assert.equal(Object.prototype.hasOwnProperty.call(adminNoDept, "departmentId"), false);
  const withDept = userCreatePayload({ identifier: "ops", password: "password1", displayName: "运营", role: "admin", departmentId: "dept_1" });
  assert.equal(withDept.departmentId, "dept_1");
  const weirdRole = userCreatePayload({ identifier: "x", password: "p", displayName: "y", role: "owner" });
  assert.equal(weirdRole.role, "user", "未知角色回落 user");
});

test("user-update 载荷：只带显式传入的键，空部门可清除归属", () => {
  const clearDept = userUpdatePayload({ userId: "u1", username: " ops ", departmentId: "", role: "user", status: "disabled" });
  assert.deepEqual(clearDept, { userId: "u1", username: "ops", departmentId: "", role: "user", status: "disabled" });
  const justStatus = userUpdatePayload({ userId: "u1", status: "active" });
  assert.deepEqual(justStatus, { userId: "u1", status: "active" });
  assert.equal(userUpdatePayload({ userId: "u1" }).role, undefined);
});

test("其余载荷构造器只输出后端契约字段", () => {
  assert.deepEqual(departmentCreatePayload({ name: " 运营部 ", description: " 负责运营 " }), { name: "运营部", description: "负责运营" });
  assert.deepEqual(departmentUpdatePayload({ departmentId: "d1", name: "新名", status: "disabled" }), { departmentId: "d1", name: "新名", status: "disabled" });
  assert.equal(Object.prototype.hasOwnProperty.call(departmentUpdatePayload({ departmentId: "d1", name: "新名" }), "status"), false);
  assert.deepEqual(resetPasswordPayload({ userId: "u1", password: "newpass12" }), { userId: "u1", password: "newpass12" });
  assert.deepEqual(appAccessRulePayload({ appId: "a1", mode: "departments", departmentIds: ["d1", "d1", ""] }), { appId: "a1", rule: { mode: "departments", departmentIds: ["d1", "d1"] } });
  assert.deepEqual(appAccessRulePayload({ appId: "a1", mode: "all", departmentIds: ["d1"] }), { appId: "a1", rule: { mode: "all", departmentIds: [] } });
  assert.deepEqual(appAccessRulePayload({ appId: "a1", mode: "bogus", departmentIds: [] }), { appId: "a1", rule: { mode: "all", departmentIds: [] } });
  const policy = appPermissionPolicyPayload({ permissionCode: " app.x.read ", decision: "allow", roles: ["admin", "admin", "bogus"], userIds: ["u1", ""], departmentIds: ["d1"], dataScope: "self" });
  assert.deepEqual(policy, { permissionCode: "app.x.read", policy: { decision: "allow", userIds: ["u1"], departmentIds: ["d1"], roles: ["admin"], dataScope: "self" } });
  assert.equal(Object.prototype.hasOwnProperty.call(appPermissionPolicyPayload({ permissionCode: "c", decision: "deny" }).policy, "dataScope"), false);
});

/* ══════════════════════════════════════════════════════════════════════════
   7 展示辅助
   ══════════════════════════════════════════════════════════════════════════ */
test("访问摘要按 appId 稳定排序，非 true 一律不允许", () => {
  assert.deepEqual(accessSummaryRows({ b: false, a: true, c: "yes" }), [
    { appId: "a", allowed: true },
    { appId: "b", allowed: false },
    { appId: "c", allowed: false },
  ]);
  assert.deepEqual(accessSummaryRows(null), []);
  assert.deepEqual(accessSummaryRows([1, 2]), []);
});

test("部门名只来自真实列表，找不到不编造；成员按部门筛选", () => {
  const depts = [{ id: "d1", name: "运营部" }, { id: "d2", name: "工程部" }];
  assert.equal(departmentName(depts, "d1"), "运营部");
  assert.equal(departmentName(depts, "d9"), "d9");
  assert.equal(departmentName(depts, ""), "未分配部门");
  const users = [{ id: "u1", departmentIds: ["d1"] }, { id: "u2", departmentIds: ["d2"] }, { id: "u3", departmentIds: [] }];
  assert.equal(filterMembers(users, "d1").length, 1);
  assert.equal(filterMembers(users, null).length, 3);
  assert.equal(filterMembers(users, "d9").length, 0);
});

test("本地语义陈述不限账号数，不出现会员 / 权益字段", () => {
  assert.ok(ORG_LOCAL_MODE_TEXT.includes("不限账号数"));
  assert.equal(/(会员|权益|套餐|积分|maxLocalAccounts|plan)/.test(ORG_LOCAL_MODE_TEXT), false);
  const text = localAccountSummaryText({ userCount: 3, departmentCount: 2 });
  assert.ok(text.includes("3 个账号") && text.includes("2 个部门"), text);
  assert.equal(/(会员|权益|套餐|积分|maxLocalAccounts|plan)/.test(text), false);
  assert.equal(localAccountSummaryText(null).includes("0 个账号"), true);
});

/* ══════════════════════════════════════════════════════════════════════════
   8 界面源码边界
   ══════════════════════════════════════════════════════════════════════════ */
test("界面源码不联网、不写 localStorage、不直连本机端口、不出现会员字样", () => {
  for (const rel of ["src/governance/GovernanceApp.tsx", "src/governance/orgConsoleLogic.ts"]) {
    const code = stripComments(read(rel));
    assert.equal(/\bfetch\s*\(/.test(code), false, rel + " 不得调用 fetch");
    assert.equal(/XMLHttpRequest|WebSocket|EventSource/.test(code), false, rel + " 不得使用网络对象");
    assert.equal(/localStorage|sessionStorage/.test(code), false, rel + " 不得写 localStorage/sessionStorage");
    assert.equal(/https?:\/\/|127\.0\.0\.1|localhost/.test(code), false, rel + " 不得直连本机端口或外网地址");
    assert.equal(/document\.cookie/.test(code), false, rel + " 不得读 cookie");
    assert.equal(/(会员|权益|套餐|积分|maxLocalAccounts|entitlement)/.test(code), false, rel + " 不得出现会员 / 权益文案或字段");
  }
});

test("界面只经 window.openarc.identity 取数据，不越域、不发操作者身份", () => {
  const code = stripComments(read("src/governance/GovernanceApp.tsx"));
  assert.ok(code.indexOf("openarc") >= 0 && code.indexOf("identity") >= 0, "必须通过 window.openarc.identity");
  assert.equal(/openarc\s*\.\s*(model|task|skill|mcp|resource|governance)\b/.test(code), false, "不得越域取数据");
  assert.equal(/sessionRef/.test(code), false, "界面不得出现 sessionRef");
  assert.equal(/localStorage/.test(code), false);
});

test("UI-4 的 CSS 只追加 .org-*，不新增 token 定义", () => {
  const css = read("src/styles.css");
  const marker = css.indexOf("UI-4 · 组织治理扩展");
  assert.ok(marker > 0, "styles.css 必须包含 UI-4 区块");
  const start = css.lastIndexOf("/*", marker);
  const tail = css.slice(start);
  // UI-4 区块边界 = 从 UI-4 注释起，到第一条不属于 .org-* 的规则为止。
  // 后续批次（例如 ModelSettings 的 .model-proto）会在同一文件继续追加，不能把它们的规则
  // 算进 UI-4 边界（旧写法切到文件末尾，后续批次一追加就误判越界）。选择器与 token 断言不放松。
  const rule = /(^|\n)\s*([^\n{}@]+)\{/g;
  let match;
  let checked = 0;
  let end = tail.length;
  while ((match = rule.exec(tail))) {
    const sel = match[2].trim();
    if (!sel || sel === "from" || sel === "to" || /%$/.test(sel)) continue;
    if (!sel.split(",").every((part) => part.trim().startsWith(".org-"))) {
      assert.notEqual(checked, 0, "UI-4 区块第一条规则必须是 .org-*：" + sel);
      end = match.index;
      break;
    }
    checked += 1;
  }
  const block = tail.slice(0, end).replace(/\/\*[\s\S]*?\*\//g, " ");
  assert.equal(/--[a-z0-9-]+\s*:/.test(block), false, "UI-4 区块不得新增 / 改写 token");
  assert.ok(checked >= 20, "至少应解析出 20 条 .org-* 规则，实际 " + checked);
});

test("main.tsx 不改动：organization 分支仍直接渲染 GovernanceApp，且不引入 orgConsoleLogic", () => {
  const code = read("src/main.tsx");
  assert.ok(code.indexOf('from "./governance/GovernanceApp"') >= 0, "main.tsx 必须仍引入 GovernanceApp");
  assert.ok(code.indexOf('w?.appId === "organization"') >= 0, "organization 分支必须保留");
  assert.ok(code.indexOf("return <GovernanceApp />") >= 0, "organization 分支仍直接渲染 GovernanceApp（导航与 dock 不改）");
  assert.equal(code.indexOf("orgConsoleLogic"), -1, "main.tsx 不得引入 UI-4 逻辑层");
});

test("tokens.css 零改动：不出现 .org- 选择器，也不出现 UI-4 标记", () => {
  const tokens = read("src/design-system/tokens.css");
  assert.equal(tokens.indexOf(".org-"), -1);
  assert.equal(tokens.indexOf("UI-4"), -1);
});
