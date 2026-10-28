/**
 * B4e · 本地账号服务测试（部门 / 用户 / APP 访问 / 审计）。
 *
 * 全部离线：真实 node:sqlite 临时库 + 真实 KDF（scrypt），不 mock 持久层，
 * 因为"落到既有表、不新建第二套账号体系"这件事只能在真库上验证。
 * 只跑本文件：node --test tests/dxos-local-account.test.mjs
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { IdentityStore } = require("../electron/identity-store.cjs");
const { AuthorizationStore } = require("../electron/authorization-store.cjs");
const { AuthorizationService } = require("../electron/authorization-service.cjs");
const { IdentityService } = require("../electron/identity-service.cjs");
const { IdentityLogger } = require("../electron/identity-log.cjs");
const { SessionSecretStore, memoryBackend } = require("../electron/session-secret-store.cjs");
const {
  LocalAccountService,
  AGENT_DEPENDENCY_UNAVAILABLE,
  APP_ACCESS_RESOURCE_TYPE,
  APP_PERMISSION_RESOURCE_TYPE,
  APP_ACCESS_DENIED,
} = require("../electron/local-account-service.cjs");

const ADMIN_ID = "admin@openarc.test";
const ADMIN_PW = "admin-password-1";
const USER_PW = "user-password-1";
const dirs = [];

after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

function fixture({ appCatalog = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-b4e-"));
  dirs.push(dir);
  const clock = (() => {
    let now = 1_800_000_000_000;
    const c = () => now;
    c.advance = (ms) => (now += ms);
    return c;
  })();
  const logger = new IdentityLogger();
  const identity = new IdentityStore({ path: path.join(dir, "identity.db"), clock }).open();
  const authStore = new AuthorizationStore({ identity });
  const authorization = new AuthorizationService({ identity, authStore });
  const secrets = new SessionSecretStore(memoryBackend());
  const identityService = new IdentityService({ store: identity, secrets, logger, allowAdmin: true });
  const deps = appCatalog ? { appCatalog } : {};
  const svc = new LocalAccountService({ identity, authStore, authorization, identityService, deps });
  return { identity, authStore, authorization, identityService, secrets, svc, clock, dir };
}

async function bootstrapped(options = {}) {
  const fx = fixture(options);
  const boot = await fx.svc.bootstrap({ identifier: ADMIN_ID, password: ADMIN_PW, displayName: "Admin" });
  assert.equal(boot.ok, true, "bootstrap: " + JSON.stringify(boot));
  const adminCtx = { sessionRef: boot.sessionRef, appId: "resource-library", source: "ui" };
  return { ...fx, boot, adminCtx };
}

async function makeUser(fx, { identifier, password = USER_PW, displayName, role = "user", departmentId = null } = {}) {
  const created = await fx.svc.createAuthUser({
    context: fx.adminCtx,
    identifier,
    password,
    displayName: displayName || identifier,
    role,
    departmentId,
  });
  assert.equal(created.ok, true, "createAuthUser " + identifier + ": " + JSON.stringify(created));
  const login = await fx.svc.login({ identifier, password });
  assert.equal(login.ok, true, "login " + identifier + ": " + JSON.stringify(login));
  return { user: created.user, sessionRef: login.sessionRef, ctx: { sessionRef: login.sessionRef, appId: "resource-library", source: "ui" } };
}

const events = (fx) => fx.identity.auditLog().map((r) => r.event);
const authzActions = (fx) => fx.authStore.authorizationAudit().map((r) => r.action);

test("B4e-01 · authStatus / localAccountInfo：Local 模式，且不含任何签名权益字段", async () => {
  const fx = fixture();
  const before = fx.svc.authStatus();
  assert.equal(before.ok, true);
  assert.equal(before.initialized, false);
  assert.equal(before.local, true);
  assert.equal(typeof before.sessionDays, "number");
  for (const forbidden of ["plan", "planName", "planGroup", "maxLocalAccounts", "maxDepartments", "departmentsEnabled", "advancedAppPolicyEnabled", "source"]) {
    assert.equal(forbidden in before, false, "不得出现签名权益字段 " + forbidden);
  }
  await fx.svc.bootstrap({ identifier: ADMIN_ID, password: ADMIN_PW, displayName: "Admin" });
  assert.equal(fx.svc.authStatus().initialized, true);
  const info = fx.svc.localAccountInfo();
  assert.deepEqual(Object.keys(info).sort(), ["departmentCount", "initialized", "local", "ok", "userCount"]);
  assert.equal(info.local, true);
  assert.equal(info.userCount, 1);
});

test("B4e-02 · 部门增删改查落到 departments，并写 audit_log + authorization_audit", async () => {
  const fx = await bootstrapped();
  const created = fx.svc.createAuthDepartment({ context: fx.adminCtx, name: "  设计部  " });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(created.department.name, "设计部");
  assert.equal(created.department.parentId, null);
  assert.equal(created.department.status, "active");
  assert.ok(fx.authStore.departmentById(created.department.id), "必须落到既有 departments 表");

  const list = fx.svc.listAuthDepartments({ context: fx.adminCtx });
  assert.equal(list.ok, true);
  assert.deepEqual(list.items.map((d) => d.name), ["设计部"]);

  assert.equal(fx.svc.createAuthDepartment({ context: fx.adminCtx, name: "设计部" }).error, "DXOS_ERR_CONFLICT");
  assert.equal(fx.svc.createAuthDepartment({ context: fx.adminCtx, name: "x" }).error, "DXOS_ERR_INVALID_INPUT");

  const updated = fx.svc.updateAuthDepartment({ context: fx.adminCtx, departmentId: created.department.id, name: "研发部" });
  assert.equal(updated.ok, true);
  assert.equal(updated.department.name, "研发部");
  const disabled = fx.svc.updateAuthDepartment({ context: fx.adminCtx, departmentId: created.department.id, status: "disabled" });
  assert.equal(disabled.department.status, "disabled");
  assert.equal(fx.svc.updateAuthDepartment({ context: fx.adminCtx, departmentId: "dept_missing", name: "不存在的部" }).error, "DXOS_ERR_NOT_FOUND");

  const deleted = fx.svc.deleteAuthDepartment({ context: fx.adminCtx, departmentId: created.department.id });
  assert.equal(deleted.deleted, true);
  assert.equal(fx.authStore.departmentById(created.department.id), null);

  const evs = events(fx);
  for (const e of ["department.create", "department.update", "department.delete"]) assert.ok(evs.includes(e), "缺少审计事件 " + e);
  const acts = authzActions(fx);
  assert.ok(acts.includes("governance.createDepartment"));
  assert.ok(acts.includes("governance.updateDepartment"));
  assert.ok(acts.includes("department.delete"));
});

test("B4e-03 · 用户创建 / 改角色 / 禁用 / 重置密码 / 删除，全部走既有 users + 成员关系", async () => {
  const fx = await bootstrapped();
  const dept = fx.svc.createAuthDepartment({ context: fx.adminCtx, name: "设计部" }).department;

  const deptAdmin = await fx.svc.createAuthUser({
    context: fx.adminCtx,
    identifier: "dept-admin@openarc.test",
    password: "dept-admin-pass-1",
    displayName: "DA",
    role: "admin",
    departmentId: dept.id,
  });
  assert.equal(deptAdmin.ok, true, JSON.stringify(deptAdmin));
  assert.equal(deptAdmin.user.role, "admin");
  assert.equal(deptAdmin.user.departmentId, dept.id);

  const normal = await fx.svc.createAuthUser({
    context: fx.adminCtx,
    identifier: "member@openarc.test",
    password: "member-pass-1",
    displayName: "M",
    role: "user",
    departmentId: dept.id,
  });
  assert.equal(normal.user.role, "user");
  const super2 = await fx.svc.createAuthUser({ context: fx.adminCtx, identifier: "super2@openarc.test", password: "super2-pass-1", displayName: "S2", role: "superadmin" });
  assert.equal(super2.user.role, "superadmin");

  assert.equal(fx.svc.listAuthUsers().items.length, 4);

  // 角色三值 → 两值：admin 用 department-admin 成员关系承载
  const toUser = await fx.svc.updateAuthUser({ context: fx.adminCtx, userId: deptAdmin.user.id, role: "user" });
  assert.equal(toUser.user.role, "user");
  const rows = fx.identity.connection.prepare("SELECT * FROM users WHERE id = ?").get(deptAdmin.user.id);
  assert.equal(rows.role, "MEMBER", "admin 不得写成 users.role='ADMIN'");
  const toAdmin = await fx.svc.updateAuthUser({ context: fx.adminCtx, userId: normal.user.id, role: "admin" });
  assert.equal(toAdmin.user.role, "admin");
  assert.equal(fx.identity.connection.prepare("SELECT * FROM users WHERE id = ?").get(normal.user.id).role, "MEMBER");

  // 无部门的 admin 无法在既有两值列 + 成员角色表里表达：显式拒绝并登记差异
  const noDept = await fx.svc.createAuthUser({ context: fx.adminCtx, identifier: "nodept@openarc.test", password: "nodept-pass-1", role: "admin" });
  assert.equal(noDept.error, "DXOS_ERR_INVALID_INPUT");

  // 禁用 + 重新登录被拒
  const disabled = await fx.svc.updateAuthUser({ context: fx.adminCtx, userId: normal.user.id, status: "disabled" });
  assert.equal(disabled.user.status, "disabled");
  assert.equal((await fx.svc.login({ identifier: "member@openarc.test", password: "member-pass-1" })).error, "USER_DISABLED");

  // 重置密码：旧口令失效、新口令可登录、会话被撤销
  const reset = await fx.svc.resetAuthPassword({ context: fx.adminCtx, userId: deptAdmin.user.id, password: "reset-pass-1" });
  assert.equal(reset.ok, true, JSON.stringify(reset));
  assert.equal((await fx.svc.login({ identifier: "dept-admin@openarc.test", password: "dept-admin-pass-1" })).error, "INVALID_CREDENTIALS");
  assert.equal((await fx.svc.login({ identifier: "dept-admin@openarc.test", password: "reset-pass-1" })).ok, true);

  // 删除：外键引用清干净后再删 users
  const del = fx.svc.deleteAuthUser({ context: fx.adminCtx, userId: normal.user.id });
  assert.equal(del.deleted, true);
  assert.equal(fx.identity.userById(normal.user.id), null);
  assert.equal(fx.identity.connection.prepare("SELECT COUNT(*) AS c FROM sessions WHERE user_id = ?").get(normal.user.id).c, 0);
  assert.equal(fx.identity.connection.prepare("SELECT COUNT(*) AS c FROM department_memberships WHERE user_id = ?").get(normal.user.id).c, 0);

  const evs = events(fx);
  for (const e of ["user.create", "user.update", "user.password.reset", "user.delete"]) assert.ok(evs.includes(e), "缺少审计事件 " + e);
  assert.ok(authzActions(fx).includes("governance.createUser"));
  assert.ok(authzActions(fx).includes("user.delete"));
});

test("B4e-04 · 登录与登出写 auth.login / auth.login.failed / auth.logout 审计行", async () => {
  const fx = await bootstrapped();
  assert.ok(events(fx).includes("auth.bootstrap"));
  const login = await fx.svc.login({ identifier: ADMIN_ID, password: ADMIN_PW });
  assert.equal(login.ok, true, JSON.stringify(login));
  assert.ok(events(fx).includes("auth.login"));
  assert.equal((await fx.svc.login({ identifier: ADMIN_ID, password: "wrong-password-9" })).error, "INVALID_CREDENTIALS");
  assert.ok(events(fx).includes("auth.login.failed"));
  const out = await fx.svc.logout({ sessionRef: login.sessionRef });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.ok(events(fx).includes("auth.logout"));
  assert.equal((await fx.svc.logout({ sessionRef: login.sessionRef })).ok, false);
  // 已删除的 entitlement_suspended 事件不得出现
  assert.equal(events(fx).some((e) => e.includes("entitlement_suspended")), false);
});

test("B4e-05 · canOpenApp / canUseAppPermission 允许与拒绝", async () => {
  const fx = await bootstrapped();
  const dept = fx.svc.createAuthDepartment({ context: fx.adminCtx, name: "设计部" }).department;
  const other = fx.svc.createAuthDepartment({ context: fx.adminCtx, name: "市场部" }).department;
  const u = await makeUser(fx, { identifier: "u1@openarc.test", departmentId: dept.id });
  const admin = fx.identity.userById(fx.boot.user.id);

  // 默认 all
  assert.equal(fx.svc.canOpenApp(u.user, "photoshop"), true);
  // departments
  assert.equal(fx.svc.saveAppAccessRule({ context: fx.adminCtx, appId: "photoshop", rule: { mode: "departments", departmentIds: [dept.id] } }).ok, true);
  assert.equal(fx.svc.canOpenApp(u.user, "photoshop"), true);
  assert.equal(fx.svc.canOpenApp(admin, "photoshop"), true, "superadmin 恒为 true");
  // 另一个部门不命中
  const u2 = await makeUser(fx, { identifier: "u2@openarc.test", departmentId: other.id });
  assert.equal(fx.svc.canOpenApp(u2.user, "photoshop"), false);
  // admins
  assert.equal(fx.svc.saveAppAccessRule({ context: fx.adminCtx, appId: "photoshop", rule: { mode: "admins" } }).ok, true);
  assert.equal(fx.svc.canOpenApp(u.user, "photoshop"), false);
  assert.equal(fx.svc.canOpenApp(admin, "photoshop"), true);
  // superadmins
  assert.equal(fx.svc.saveAppAccessRule({ context: fx.adminCtx, appId: "photoshop", rule: { mode: "superadmins" } }).ok, true);
  assert.equal(fx.svc.canOpenApp(u.user, "photoshop"), false);
  assert.equal(fx.svc.canOpenApp(admin, "photoshop"), true);
  // 系统入口
  assert.equal(fx.svc.canOpenApp(u.user, "accounts"), false);
  assert.equal(fx.svc.canOpenApp(u.user, "api-settings"), false);
  assert.equal(fx.svc.canOpenApp(admin, "accounts"), true, "superadmin 先于系统入口判定");
  // 未安装 App：源语义为 true
  assert.equal(fx.svc.canOpenApp(u.user, "not-installed-app"), true);
  // canUseAppPermission：app.<id>. 前缀回落到 canOpenApp；无前缀恒 true
  assert.equal(fx.svc.canUseAppPermission(u.user, "app.photoshop.export"), false);
  assert.equal(fx.svc.canUseAppPermission(u.user, "ui.notify"), true);
  assert.equal(fx.svc.canUseAppPermission(u.user, ""), true);
  assert.equal(fx.svc.canUseAppPermission(null, "app.photoshop.export"), false);
});

test("B4e-06 · APP 访问规则与权限策略保存后的快照 + appAccessSummary + 保留字命名空间无副作用", async () => {
  const fx = await bootstrapped();
  const dept = fx.svc.createAuthDepartment({ context: fx.adminCtx, name: "设计部" }).department;
  const u = await makeUser(fx, { identifier: "u1@openarc.test", departmentId: dept.id });

  assert.equal(
    fx.svc.saveAppAccessRule({ context: fx.adminCtx, appId: "photoshop", rule: { mode: "departments", departmentIds: [dept.id] } }).ok,
    true,
  );
  const policy = await fx.svc.saveAppPermissionPolicy({
    context: fx.adminCtx,
    permissionCode: "app.photoshop.export",
    policy: { decision: "deny", userIds: [u.user.id], departmentIds: [dept.id], roles: ["user"], dataScope: "self" },
  });
  assert.equal(policy.ok, true, JSON.stringify(policy));
  assert.equal(policy.policy.decision, "deny");

  const snap = fx.svc.appPermissionSnapshot({ userId: u.user.id });
  assert.equal(snap.ok, true);
  assert.equal(snap.local, true);
  assert.equal(snap.externalAppAccess.photoshop.mode, "departments");
  assert.deepEqual(snap.externalAppAccess.photoshop.departmentIds, [dept.id]);
  assert.equal(snap.permissionPolicies["app.photoshop.export"].decision, "deny");
  assert.deepEqual(snap.permissionPolicies["app.photoshop.export"].roles, ["user"]);
  assert.equal(snap.permissionPolicies["app.photoshop.export"].dataScope, "self");
  assert.equal(snap.developerApps.available, false);
  assert.equal(snap.developerApps.code, AGENT_DEPENDENCY_UNAVAILABLE);

  const summary = fx.svc.appAccessSummary(u.user);
  assert.equal(summary.ok, true);
  assert.equal(summary.summary.photoshop, true);
  assert.equal(summary.summary.accounts, false);
  assert.equal(typeof summary.summary["resource-library"], "boolean");

  const accessRows = fx.authStore.allAppGrants().filter((r) => r.resource_type === APP_ACCESS_RESOURCE_TYPE);
  assert.equal(accessRows.length, 1);
  assert.equal(accessRows[0].app_id, "photoshop");
  const policyRows = fx.authStore.allAppGrants().filter((r) => r.resource_type === APP_PERMISSION_RESOURCE_TYPE);
  assert.equal(policyRows.length, 1);
  assert.equal(policyRows[0].resource_id, "app.photoshop.export");
  // 保留字不是 baseline 家族：不得写 app_policy_provisions
  assert.equal(fx.authStore.allPolicyProvisions().length, 0);
  assert.ok(events(fx).includes("app_access.update"));
  assert.ok(events(fx).includes("app_permission.update"));
});

test("B4e-07 · 越权操作被拒（非超级管理员 / 无会话）", async () => {
  const fx = await bootstrapped();
  const dept = fx.svc.createAuthDepartment({ context: fx.adminCtx, name: "设计部" }).department;
  const u = await makeUser(fx, { identifier: "w1@openarc.test", departmentId: dept.id });

  assert.equal(fx.svc.createAuthDepartment({ context: u.ctx, name: "越权部" }).error, "NOT_SUPER_ADMIN");
  assert.equal(fx.svc.updateAuthDepartment({ context: u.ctx, departmentId: dept.id, name: "改名" }).error, "NOT_SUPER_ADMIN");
  assert.equal(fx.svc.deleteAuthDepartment({ context: u.ctx, departmentId: dept.id }).error, "NOT_SUPER_ADMIN");
  assert.equal((await fx.svc.createAuthUser({ context: u.ctx, identifier: "z@openarc.test", password: "zzzzzzzz-1" })).error, "NOT_SUPER_ADMIN");
  assert.equal((await fx.svc.updateAuthUser({ context: u.ctx, userId: fx.boot.user.id, role: "user" })).error, "NOT_SUPER_ADMIN");
  assert.equal(fx.svc.deleteAuthUser({ context: u.ctx, userId: fx.boot.user.id }).error, "NOT_SUPER_ADMIN");
  assert.equal((await fx.svc.resetAuthPassword({ context: u.ctx, userId: fx.boot.user.id, password: "zzzzzzzz-1" })).error, "NOT_SUPER_ADMIN");
  assert.equal(fx.svc.saveAppAccessRule({ context: u.ctx, appId: "photoshop", rule: { mode: "all" } }).error, "NOT_SUPER_ADMIN");
  assert.equal(
    fx.svc.saveAppPermissionPolicy({ context: u.ctx, permissionCode: "app.photoshop.export", policy: { decision: "allow" } }).error,
    "NOT_SUPER_ADMIN",
  );
  assert.equal(fx.svc.listAppCatalog({ context: u.ctx }).error, "NOT_SUPER_ADMIN");
  assert.equal(fx.svc.requireAppOpen({ context: u.ctx, appId: "accounts" }).error, APP_ACCESS_DENIED);
  assert.equal(fx.svc.saveAppAccessRule({ context: {}, appId: "photoshop", rule: { mode: "all" } }).error, "DXOS_ERR_FORBIDDEN");
  assert.equal(fx.svc.requireAppOpen({ context: {}, appId: "photoshop" }).error, "DXOS_ERR_FORBIDDEN");
  // 部门仍在
  assert.ok(fx.authStore.departmentById(dept.id));
});

test("B4e-08 · 必须保留至少一位启用的超级管理员即可删除保护", async () => {
  const fx = await bootstrapped();
  const adminId = fx.identity.userByIdentifier(ADMIN_ID).id;
  assert.equal(fx.svc.deleteAuthUser({ context: fx.adminCtx, userId: adminId }).error, "DXOS_ERR_CONFLICT");
  await fx.svc.createAuthUser({ context: fx.adminCtx, identifier: "super2@openarc.test", password: "super2-pass-1", displayName: "S2", role: "superadmin" });
  const ok = fx.svc.deleteAuthUser({ context: fx.adminCtx, userId: adminId });
  assert.equal(ok.deleted, true);
});

test("B4e-09 · B7 开发者 App 未注入 → 结构化 AGENT_DEPENDENCY_UNAVAILABLE，不伪造清单", async () => {
  const fx = await bootstrapped();
  const catalog = fx.svc.listAppCatalog({ context: fx.adminCtx });
  assert.equal(catalog.ok, true);
  assert.equal(catalog.developerApps.available, false);
  assert.equal(catalog.developerApps.code, AGENT_DEPENDENCY_UNAVAILABLE);
  assert.deepEqual(catalog.developerApps.items, []);
  const snap = fx.svc.appPermissionSnapshot({ userId: fx.boot.user.id });
  assert.deepEqual(snap.permissionManifests, []);
  // 未被清单认可的代码：退化为源正则形状；无 app.<id>. 前缀一律拒绝
  assert.equal(
    fx.svc.saveAppPermissionPolicy({ context: fx.adminCtx, permissionCode: "dev.custom", policy: { decision: "allow" } }).error,
    "DXOS_ERR_INVALID_INPUT",
  );
});

test("B4e-10 · B7 开发者 App 注入后进入目录与快照", async () => {
  const fake = {
    listInstalledApps: () => [{ id: "dev-app", name: "Dev 应用", desc: "开发应用" }],
    listPermissionManifests: () => [
      { appId: "dev-app", appName: "Dev 应用", permissions: [{ code: "dev.custom", label: "自定义", description: "d" }] },
    ],
  };
  const fx = await bootstrapped({ appCatalog: fake });
  const catalog = fx.svc.listAppCatalog({ context: fx.adminCtx });
  assert.equal(catalog.ok, true);
  assert.ok(catalog.apps.some((a) => a.id === "dev-app"));
  assert.equal(catalog.developerApps.available, true);
  const snap = fx.svc.appPermissionSnapshot({ userId: fx.boot.user.id });
  assert.equal(snap.permissionManifests.length, 1);
  const saved = fx.svc.saveAppPermissionPolicy({ context: fx.adminCtx, permissionCode: "dev.custom", policy: { decision: "allow" } });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal(fx.svc.appPermissionSnapshot({ userId: fx.boot.user.id }).permissionPolicies["dev.custom"].decision, "allow");
});

test("B4e-11 · changeOwnPassword：旧口令校验 + 全量撤销（比源更严）", async () => {
  const fx = await bootstrapped();
  const dept = fx.svc.createAuthDepartment({ context: fx.adminCtx, name: "设计部" }).department;
  const u = await makeUser(fx, { identifier: "u1@openarc.test", departmentId: dept.id });
  const changed = await fx.svc.changeOwnPassword({ context: u.ctx, oldPassword: USER_PW, newPassword: "brand-new-pass-1" });
  assert.equal(changed.ok, true, JSON.stringify(changed));
  assert.equal(changed.revokedAllSessions, true);
  assert.ok(events(fx).includes("user.password.change"));
  assert.equal((await fx.svc.login({ identifier: u.user.username, password: "brand-new-pass-1" })).ok, true);
  const u2 = await makeUser(fx, { identifier: "u2@openarc.test", departmentId: dept.id });
  assert.equal(
    (await fx.svc.changeOwnPassword({ context: u2.ctx, oldPassword: "nope-nope-1", newPassword: "another-pass-1" })).error,
    "INVALID_CREDENTIALS",
  );
  assert.equal((await fx.svc.changeOwnPassword({ context: u2.ctx, oldPassword: USER_PW, newPassword: USER_PW })).error, "DXOS_ERR_INVALID_INPUT");
});

test("B4e-12 · 登录成功后 users/sessions/audit 都是既有表，且审计事件名保持源语义", async () => {
  const fx = await bootstrapped();
  const u = await makeUser(fx, { identifier: "u1@openarc.test" });
  assert.ok(fx.identity.userById(u.user.id));
  assert.ok(fx.identity.sessionByRef(u.sessionRef));
  const log = fx.identity.auditLog();
  for (const row of log) {
    for (const key of Object.keys(row)) {
      assert.ok(
        ["id", "at", "event", "user_ref", "session_ref_hash", "result", "error_code", "duration_ms"].includes(key),
        "audit_log 出现非既有列 " + key,
      );
    }
  }
  // 不新建账号表：本地账号只允许落到既有表
  const tables = fx.identity.connection
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r) => r.name);
  for (const t of ["auth_users", "auth_departments", "auth_sessions", "auth_audit_logs", "app_access_rules", "app_permission_policies"]) {
    assert.equal(tables.includes(t), false, "不得新建第二套账号表 " + t);
  }
});

test("B4e-13 · attachAppCatalog 晚绑定：已装 App 进入 catalog；形状不符回落既有降级", async () => {
  const fx = await bootstrapped();
  assert.equal(fx.svc.listAppCatalog({ context: fx.adminCtx }).developerApps.available, false);
  const fake = {
    listInstalledApps: () => [{ id: "dev-late", name: "晚绑定应用", desc: "开发应用" }],
    listPermissionManifests: () => [
      { appId: "dev-late", appName: "晚绑定应用", permissions: [{ code: "app.dev-late.a", label: "a", description: "a" }] },
    ],
  };
  assert.equal(fx.svc.attachAppCatalog(fake), true);
  const catalog = fx.svc.listAppCatalog({ context: fx.adminCtx });
  assert.equal(catalog.developerApps.available, true);
  assert.ok(catalog.apps.some((a) => a.id === "dev-late"));
  assert.equal(fx.svc.appPermissionSnapshot({ userId: fx.boot.user.id }).permissionManifests.length, 1);

  // 形状不符：回落到"未注入"降级语义，不伪造目录
  assert.equal(fx.svc.attachAppCatalog({}), false);
  assert.equal(fx.svc.listAppCatalog({ context: fx.adminCtx }).developerApps.available, false);
});

test("B4e-14 · 装配点：main.cjs 在 developerBundle 之后把 App 目录晚绑定给 localAccountService", () => {
  const src = fs.readFileSync(new URL("../electron/runtime-composition.cjs", import.meta.url), "utf8");
  assert.match(src, /createDeveloperAppCatalogAdapter\(/);
  assert.match(src, /localAccountService\.attachAppCatalog\(/);
});
