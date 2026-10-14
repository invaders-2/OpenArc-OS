/**
 * B4 · 本地账号 IPC 接线测试（全离线：假 ipcMain + 真实临时 identity 库 + 真实 KDF）。
 *
 * 覆盖任务书验收条目：
 *   ① 命令表白名单 / risk / credential（identity-domain.cjs LOCAL_ACCOUNT_COMMANDS）
 *   ② trusted(sender) 拒绝伪造 sender
 *   ③ 未认证拒绝（无会话 / 伪造 sessionRef）
 *   ④ 部门与用户 CRUD 落库并产生审计行（audit_log / authorization_audit，事件名保留 B4e 源语义）
 *   ⑤ APP 访问规则保存后的快照与 summary
 *   ⑥ 非法输入（无部门 admin、越权）被拒
 *   ⑦ 返回值脱敏（口令 / 哈希 / 密钥 / 绝对路径）
 *
 * 只读源：electron/identity-domain.cjs、identity-service.cjs、identity-bootstrap.cjs、
 *         local-account-service.cjs、authorization-service.cjs。
 * 只跑本文件：node --test tests/dxos-local-account-ipc.test.mjs
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const domain = require("../electron/identity-domain.cjs");
const { IdentityStore } = require("../electron/identity-store.cjs");
const { AuthorizationStore } = require("../electron/authorization-store.cjs");
const { AuthorizationService } = require("../electron/authorization-service.cjs");
const { IdentityService } = require("../electron/identity-service.cjs");
const { IdentityLogger } = require("../electron/identity-log.cjs");
const { SessionSecretStore, memoryBackend } = require("../electron/session-secret-store.cjs");
const { LocalAccountService } = require("../electron/local-account-service.cjs");
const { registerIdentityIpc } = require("../electron/identity-bootstrap.cjs");

const ADMIN_ID = "admin@openarc.test";
const ADMIN_PW = "admin-password-1";
const USER_PW = "user-password-1";
const dirs = [];

after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-b4-ipc-"));
  dirs.push(dir);
  const identity = new IdentityStore({ path: path.join(dir, "identity.db"), clock: () => 1_800_000_000_000 + Date.now() }).open();
  const authStore = new AuthorizationStore({ identity });
  const authorization = new AuthorizationService({ identity, authStore });
  const service = new IdentityService({ store: identity, secrets: new SessionSecretStore(memoryBackend()), logger: new IdentityLogger(), allowAdmin: true });
  const localAccount = new LocalAccountService({ identity, authStore, authorization, identityService: service });
  service.attachLocalAccount(localAccount);
  return { dir, identity, authStore, authorization, service, localAccount };
}

async function bootstrapped() {
  const fx = fixture();
  const init = await fx.service.dispatch({ type: "identity/initialize", identifier: ADMIN_ID, password: ADMIN_PW, displayName: "Admin" });
  assert.equal(init.ok, true, "initialize: " + JSON.stringify(init));
  const login = await fx.service.dispatch({ type: "identity/login", identifier: ADMIN_ID, password: ADMIN_PW });
  assert.equal(login.ok, true, "login: " + JSON.stringify(login));
  return { ...fx, adminRef: login.snapshot.sessionRef };
}

const events = (fx) => fx.identity.auditLog().map((row) => row.event);
const authzActions = (fx) => fx.authStore.authorizationAudit().map((row) => row.action);

/** 假 ipcMain：与 electron/identity-bootstrap.cjs:264 的 handle 用法一致。 */
function makeIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, fn) { handlers.set(channel, fn); },
    removeHandler(channel) { handlers.delete(channel); },
    async invoke(channel, event, payload) {
      const fn = handlers.get(channel);
      if (!fn) throw new Error("NO_HANDLER " + channel);
      return fn(event, payload);
    },
  };
}

const TRUSTED_SENDER = { id: "trusted-web-contents" };
const TRUSTED_URL = "file:///Application/OpenArc%20OS/index.html";
const trustedEvent = () => ({ sender: TRUSTED_SENDER, senderFrame: { url: TRUSTED_URL } });
const trustedGate = (event) => !!event && event.sender === TRUSTED_SENDER && !!event.senderFrame && event.senderFrame.url === TRUSTED_URL;

function wire(fx) {
  const ipc = makeIpcMain();
  registerIdentityIpc({ ipcMain: ipc, service: fx.service, isTrusted: trustedGate });
  return ipc;
}
const call = (ipc, command) => ipc.invoke("identity:command", trustedEvent(), command);

// ── ① 命令表 ─────────────────────────────────────────────────────────────
test("① 命令表：14 条本地账号命令、risk/credential 合法，既有身份命令逐字不变", () => {
  const required = [
    "identity/departments-list", "identity/department-create", "identity/department-update", "identity/department-delete",
    "identity/users-list", "identity/user-create", "identity/user-update", "identity/user-delete", "identity/user-reset-password",
    "identity/app-access-rule-save", "identity/app-permission-policy-save", "identity/app-permission-snapshot", "identity/app-access-summary",
    "identity/local-account-info",
  ];
  const commands = domain.listLocalAccountCommands();
  assert.deepEqual(commands.map((entry) => entry.command), required);
  for (const entry of commands) {
    assert.ok(["read", "use", "manage", "destructive"].includes(entry.risk), entry.command + " risk=" + entry.risk);
    assert.equal(typeof entry.credential, "boolean", entry.command);
    assert.ok(entry.summary && /[\u4e00-\u9fff]/.test(entry.summary), entry.command + " summary 必须为中文");
    assert.ok(domain.ALL_COMMANDS.includes(entry.command), entry.command + " 必须在 ALL_COMMANDS 白名单");
  }
  assert.equal(domain.localAccountCommandRisk("identity/department-delete"), "destructive");
  assert.equal(domain.localAccountCommandRisk("identity/user-reset-password"), "manage");
  assert.equal(domain.localAccountCommandRisk("identity/users-list"), "read");
  assert.equal(domain.localAccountCommandRequiresCredential("identity/user-create"), true);
  assert.equal(domain.localAccountCommandRequiresCredential("identity/user-reset-password"), true);
  assert.equal(domain.localAccountCommandRequiresCredential("identity/department-delete"), false);
  assert.equal(domain.isLocalAccountCommand("identity/local-account-info"), true);
  assert.equal(domain.isLocalAccountCommand("identity/nope"), false);
  assert.equal(domain.localAccountCommandRisk("identity/nope"), null);

  // 既有命令行为逐字不变。
  assert.deepEqual(domain.IDENTITY_COMMANDS, [
    "identity/status", "identity/initialize", "identity/login", "identity/restore", "identity/logout",
    "identity/lock", "identity/unlock", "identity/change-password", "identity/validate", "identity/update-profile",
  ]);
  assert.deepEqual(domain.ADMIN_COMMANDS, ["identity/disable-user", "identity/enable-user", "identity/reset-installation"]);
});

// ── ② trusted(sender) ───────────────────────────────────────────────────
test("② trusted(sender)：伪造 sender / 伪造来源页一律拒绝（fail closed）", async () => {
  const fx = await bootstrapped();
  const ipc = wire(fx);
  const ok = await call(ipc, { type: "identity/departments-list", sessionRef: fx.adminRef });
  assert.equal(ok.ok, true);

  await assert.rejects(
    () => ipc.invoke("identity:command", { sender: { id: "forged" }, senderFrame: { url: TRUSTED_URL } }, { type: "identity/users-list", sessionRef: fx.adminRef }),
    /Forbidden/,
  );
  await assert.rejects(
    () => ipc.invoke("identity:command", { sender: TRUSTED_SENDER, senderFrame: { url: "https://evil.example/app" } }, { type: "identity/users-list", sessionRef: fx.adminRef }),
    /Forbidden/,
  );
});

// ── ③ 未认证 ─────────────────────────────────────────────────────────────
test("③ 未认证 / 伪造 sessionRef：本地账号命令一律拒绝", async () => {
  const fx = fixture();
  const ipc = wire(fx);
  const noSession = await call(ipc, { type: "identity/departments-list" });
  assert.equal(noSession.ok, false);
  assert.equal(noSession.error, "SESSION_REVOKED");
  const forged = await call(ipc, { type: "identity/users-list", sessionRef: "sref_forged_not_a_session" });
  assert.equal(forged.ok, false);
  assert.equal(forged.error, "SESSION_REVOKED");
  const writable = await call(ipc, { type: "identity/department-create", sessionRef: "sref_forged_not_a_session", name: "越权部" });
  assert.equal(writable.ok, false);
  assert.equal(writable.error, "SESSION_REVOKED");
  // 未白名单命令不因新增命令表而放行。
  const unknown = await call(ipc, { type: "identity/local-account-nuke", sessionRef: "sref_x" });
  assert.equal(unknown.error, "INVALID_INPUT");
});

// ── ④ 部门 CRUD + 审计 ───────────────────────────────────────────────────
test("④ 部门 CRUD 经 identity:command 落库，并写 audit_log + authorization_audit", async () => {
  const fx = await bootstrapped();
  const ipc = wire(fx);

  const created = await call(ipc, { type: "identity/department-create", sessionRef: fx.adminRef, name: "  设计部  " });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(created.department.name, "设计部");
  assert.ok(fx.authStore.departmentById(created.department.id), "必须落到既有 departments 表");

  const list = await call(ipc, { type: "identity/departments-list", sessionRef: fx.adminRef });
  assert.deepEqual(list.items.map((d) => d.name), ["设计部"]);

  const duplicated = await call(ipc, { type: "identity/department-create", sessionRef: fx.adminRef, name: "设计部" });
  assert.equal(duplicated.error, "DXOS_ERR_CONFLICT");
  const tooShort = await call(ipc, { type: "identity/department-create", sessionRef: fx.adminRef, name: "x" });
  assert.equal(tooShort.error, "DXOS_ERR_INVALID_INPUT");

  const updated = await call(ipc, { type: "identity/department-update", sessionRef: fx.adminRef, departmentId: created.department.id, name: "研发部" });
  assert.equal(updated.department.name, "研发部");

  const deleted = await call(ipc, { type: "identity/department-delete", sessionRef: fx.adminRef, departmentId: created.department.id });
  assert.equal(deleted.deleted, true);
  assert.equal(fx.authStore.departmentById(created.department.id), null);

  const evs = events(fx);
  for (const name of ["department.create", "department.update", "department.delete"]) assert.ok(evs.includes(name), "缺少审计事件 " + name);
  const actions = authzActions(fx);
  assert.ok(actions.includes("governance.createDepartment"));
  assert.ok(actions.includes("department.delete"));
});

// ── ④b 用户 CRUD + 审计 + 脱敏 ───────────────────────────────────────────
test("④b 用户 CRUD 经 identity:command 落库，审计齐全，返回值不含口令/哈希/路径", async () => {
  const fx = await bootstrapped();
  const ipc = wire(fx);
  const dept = (await call(ipc, { type: "identity/department-create", sessionRef: fx.adminRef, name: "设计部" })).department;

  const created = await call(ipc, {
    type: "identity/user-create", sessionRef: fx.adminRef,
    identifier: "u1@openarc.test", password: USER_PW, displayName: "U1", departmentId: dept.id, role: "user",
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(created.user.username, "u1@openarc.test");
  assert.equal(created.user.departmentId, dept.id);
  const userId = created.user.id;

  const list = await call(ipc, { type: "identity/users-list", sessionRef: fx.adminRef });
  assert.ok(list.items.some((item) => item.id === userId));

  const promoted = await call(ipc, { type: "identity/user-update", sessionRef: fx.adminRef, userId, role: "admin" });
  assert.equal(promoted.user.role, "admin");
  assert.equal(fx.identity.connection.prepare("SELECT role FROM users WHERE id = ?").get(userId).role, "MEMBER");

  const reset = await call(ipc, { type: "identity/user-reset-password", sessionRef: fx.adminRef, userId, password: "reset-pass-1" });
  assert.equal(reset.ok, true, JSON.stringify(reset));
  assert.equal(reset.userId, userId);

  const removed = await call(ipc, { type: "identity/user-delete", sessionRef: fx.adminRef, userId });
  assert.equal(removed.deleted, true);
  assert.equal(fx.identity.userById(userId), null);

  const evs = events(fx);
  for (const name of ["user.create", "user.update", "user.password.reset", "user.delete"]) assert.ok(evs.includes(name), "缺少审计事件 " + name);
  assert.ok(authzActions(fx).includes("governance.createUser"));
  assert.ok(authzActions(fx).includes("user.delete"));

  // 脱敏：口令 / 哈希 / 密钥字段 / 绝对路径都不得出现在任一返回值里。
  const serialized = JSON.stringify([created, list, promoted, reset, removed]);
  assert.equal(serialized.includes(USER_PW), false, "返回值不得含口令");
  assert.equal(serialized.includes("reset-pass-1"), false, "返回值不得含新口令");
  assert.equal(/password|passwd|hash|secret|api[_-]?key|credential|token/i.test(serialized), false, "返回值不得出现凭据类字段名");
  assert.equal(serialized.includes(fx.dir), false, "返回值不得含绝对路径");
  for (const key of Object.keys(created.user)) {
    assert.equal(/password|passwd|hash|secret|api[_-]?key|credential|token/i.test(key), false, "用户投影出现凭据字段 " + key);
  }
});

// ── ⑤ APP 访问规则 → 快照 / summary ─────────────────────────────────────
test("⑤ APP 访问规则与权限策略保存后的快照 + appAccessSummary", async () => {
  const fx = await bootstrapped();
  const ipc = wire(fx);
  const dept = (await call(ipc, { type: "identity/department-create", sessionRef: fx.adminRef, name: "设计部" })).department;
  const user = (await call(ipc, {
    type: "identity/user-create", sessionRef: fx.adminRef,
    identifier: "u1@openarc.test", password: USER_PW, displayName: "U1", departmentId: dept.id, role: "user",
  })).user;

  const rule = await call(ipc, { type: "identity/app-access-rule-save", sessionRef: fx.adminRef, appId: "photoshop", rule: { mode: "departments", departmentIds: [dept.id] } });
  assert.equal(rule.ok, true, JSON.stringify(rule));
  assert.equal(rule.rule.mode, "departments");

  const policy = await call(ipc, {
    type: "identity/app-permission-policy-save", sessionRef: fx.adminRef,
    permissionCode: "app.photoshop.export",
    policy: { decision: "deny", userIds: [user.id], departmentIds: [dept.id], roles: ["user"], dataScope: "self" },
  });
  assert.equal(policy.ok, true, JSON.stringify(policy));
  assert.equal(policy.policy.decision, "deny");

  const snapshot = await call(ipc, { type: "identity/app-permission-snapshot", sessionRef: fx.adminRef, userId: user.id });
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.externalAppAccess.photoshop.mode, "departments");
  assert.deepEqual(snapshot.externalAppAccess.photoshop.departmentIds, [dept.id]);
  assert.equal(snapshot.permissionPolicies["app.photoshop.export"].decision, "deny");
  assert.deepEqual(snapshot.permissionPolicies["app.photoshop.export"].roles, ["user"]);
  assert.equal(snapshot.developerApps.available, false, "B7 未注入 → 结构化依赖缺失，不伪造清单");

  const summary = await call(ipc, { type: "identity/app-access-summary", sessionRef: fx.adminRef, userId: user.id });
  assert.equal(summary.ok, true);
  assert.equal(summary.summary.photoshop, true);
  assert.equal(typeof summary.summary.accounts, "boolean");
  assert.equal(typeof summary.summary["resource-library"], "boolean");

  const info = await call(ipc, { type: "identity/local-account-info", sessionRef: fx.adminRef });
  assert.equal(info.local, true);
  assert.equal(info.userCount, 2);
  assert.equal(info.departmentCount, 1);
  assert.deepEqual(Object.keys(info).sort(), ["departmentCount", "durationMs", "initialized", "local", "ok", "userCount"]);

  assert.ok(events(fx).includes("app_access.update"));
  assert.ok(events(fx).includes("app_permission.update"));
});

// ── ⑥ 非法输入 / 越权 ───────────────────────────────────────────────────
test("⑥ 非法输入与越权：无部门 admin、非超级管理员写操作一律拒绝", async () => {
  const fx = await bootstrapped();
  const ipc = wire(fx);
  const dept = (await call(ipc, { type: "identity/department-create", sessionRef: fx.adminRef, name: "设计部" })).department;

  const noDeptAdmin = await call(ipc, {
    type: "identity/user-create", sessionRef: fx.adminRef,
    identifier: "nodept@openarc.test", password: "nodept-pass-1", role: "admin",
  });
  assert.equal(noDeptAdmin.error, "DXOS_ERR_INVALID_INPUT");

  const memberCreate = await call(ipc, {
    type: "identity/user-create", sessionRef: fx.adminRef,
    identifier: "m1@openarc.test", password: USER_PW, displayName: "M1", departmentId: dept.id, role: "user",
  });
  assert.equal(memberCreate.ok, true);
  const memberLogin = await call(ipc, { type: "identity/login", identifier: "m1@openarc.test", password: USER_PW });
  assert.equal(memberLogin.ok, true);
  const memberRef = memberLogin.snapshot.sessionRef;

  const forbidden = [
    await call(ipc, { type: "identity/department-create", sessionRef: memberRef, name: "越权部" }),
    await call(ipc, { type: "identity/department-update", sessionRef: memberRef, departmentId: dept.id, name: "改名" }),
    await call(ipc, { type: "identity/department-delete", sessionRef: memberRef, departmentId: dept.id }),
    await call(ipc, { type: "identity/user-create", sessionRef: memberRef, identifier: "z@openarc.test", password: "zzzzzz-1" }),
    await call(ipc, { type: "identity/user-update", sessionRef: memberRef, userId: fx.identity.userByIdentifier(ADMIN_ID).id, role: "user" }),
    await call(ipc, { type: "identity/user-delete", sessionRef: memberRef, userId: fx.identity.userByIdentifier(ADMIN_ID).id }),
    await call(ipc, { type: "identity/user-reset-password", sessionRef: memberRef, userId: fx.identity.userByIdentifier(ADMIN_ID).id, password: "zzzzzz-1" }),
    await call(ipc, { type: "identity/app-access-rule-save", sessionRef: memberRef, appId: "photoshop", rule: { mode: "all" } }),
    await call(ipc, { type: "identity/app-permission-policy-save", sessionRef: memberRef, permissionCode: "app.photoshop.export", policy: { decision: "allow" } }),
  ];
  for (const result of forbidden) assert.equal(result.error, "NOT_SUPER_ADMIN", JSON.stringify(result));

  assert.ok(fx.authStore.departmentById(dept.id), "越权失败后部门仍在");
  assert.equal(fx.identity.userById(fx.identity.userByIdentifier(ADMIN_ID).id).status, "ACTIVE");
});

// ── ⑦ 审计留痕：本地账号写入必须落审计 ───────────────────────────────────
test("⑦ 审计：B4e 源语义事件名进入 audit_log / authorization_audit", async () => {
  const fx = await bootstrapped();
  const ipc = wire(fx);
  const dept = (await call(ipc, { type: "identity/department-create", sessionRef: fx.adminRef, name: "设计部" })).department;
  await call(ipc, { type: "identity/app-access-rule-save", sessionRef: fx.adminRef, appId: "photoshop", rule: { mode: "admins" } });
  await call(ipc, { type: "identity/department-delete", sessionRef: fx.adminRef, departmentId: dept.id });

  const evs = events(fx);
  assert.ok(evs.includes("department.create"));
  assert.ok(evs.includes("app_access.update"));
  assert.ok(evs.includes("department.delete"));
  assert.equal(evs.some((name) => name.includes("entitlement_suspended")), false, "已 OUT 的额度事件不得出现");
  const actions = authzActions(fx);
  assert.ok(actions.includes("app_access.update"));
  assert.ok(actions.includes("department.delete"));
});
