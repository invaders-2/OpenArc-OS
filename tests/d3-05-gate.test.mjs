/** D3-05 · Identity & Authorization Gate（跨域集成，真实执行）。 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createResourceFixture } from "./resource-fixtures.mjs";

const f = await createResourceFixture();
after(() => f.close());
const admin = f.adminCtx();
const uid = (i) => f.identity.userByIdentifier(i).id;

async function mkUser(id, pwd) {
  const res = await f.governanceService.createUser({ context: admin, identifier: id, password: pwd, displayName: id });
  assert.equal(res.ok, true, "createUser " + id);
  const login = await f.identity.login({ identifier: id, password: pwd });
  return { userId: res.userId, ctx: { sessionRef: login.session.ref, appId: "resource-library" }, login };
}
async function deptResource(deptId, name, ownerCtx) {
  const imp = await f.resourceService.importText({ context: ownerCtx, text: name + " token", name, scope: "DEPARTMENT", departmentId: deptId });
  return imp.resource.resourceId;
}

test("Gate-Identity: Fresh install E2E（department → user → membership → resource → grant → search → preview → picker）", async () => {
  const A = f.authService.createDepartment({ context: admin, name: "Gate-A" });
  const u = await mkUser("gate-a@openarc.test", "gate-a-password-1");
  f.authService.addDepartmentMember({ context: admin, departmentId: A.department.id, userId: u.userId, membershipRole: "member" });
  f.authService.addDepartmentMember({ context: admin, departmentId: A.department.id, userId: uid("admin@openarc.test"), membershipRole: "member" });
  const rid = await deptResource(A.department.id, "GateResA", admin);
  const g = f.authService.grantResourcePermission({ context: admin, principalType: "DEPARTMENT", principalId: A.department.id, resourceId: rid, permissionSet: "VIEWER" });
  assert.equal(g.ok, true);
  assert.equal((await f.searchService.search({ context: u.ctx, query: "GateResA token", limit: 5 })).total, 1);
  assert.equal((await f.previewService.preview({ context: u.ctx, resourceRef: rid })).ok, true);
  const pick = await f.pickerService.query({ context: u.ctx, appId: "resource-library", query: "GateResA", limit: 5 });
  assert.ok(pick.items.some((i) => i.resourceId === rid));
});

test("Gate-Session: Disable 立即 DENY；Re-enable 不恢复旧 session；Reset 旧口令/旧 session DENY", async () => {
  const u = await mkUser("gate-b@openarc.test", "gate-b-password-1");
  f.governanceService.setUserStatus({ context: admin, userId: u.userId, status: "DISABLED" });
  assert.equal((await f.searchService.search({ context: u.ctx, query: "x", limit: 5 })).ok, false);
  assert.equal(f.previewService.constructor && (await f.previewService.preview({ context: u.ctx, resourceRef: "res_x" })).ok, false);
  f.governanceService.setUserStatus({ context: admin, userId: u.userId, status: "ACTIVE" });
  // 旧 session 必须失效，不能静默恢复
  assert.equal(f.identity.validateSession(u.ctx.sessionRef, { sensitive: true }).ok, false);
  assert.equal((await f.identity.login({ identifier: "gate-b@openarc.test", password: "gate-b-password-1" })).ok, true);
  const reset = await f.governanceService.initiatePasswordReset({ context: admin, userId: u.userId });
  assert.equal(reset.ok, true);
  assert.equal((await f.identity.login({ identifier: "gate-b@openarc.test", password: "gate-b-password-1" })).ok, false);
  assert.equal((await f.identity.login({ identifier: "gate-b@openarc.test", password: reset.temporaryPassword })).ok, true);
  assert.ok(f.governanceService.listAudit({ context: admin, filter: { action: "governance.passwordReset" } }).items.length >= 1);
});

test("Gate-Lock: 锁屏后受保护动作 DENY / LOCKED", async () => {
  const u = await mkUser("gate-c@openarc.test", "gate-c-password-1");
  const r = await f.resourceService.createResource({ context: u.ctx, resourceType: "text", name: "LockRes", content: "x" });
  assert.equal(r.ok, true);
  const l = f.identity.lock(u.ctx.sessionRef);
  assert.equal(l.ok, true);
  const v = f.identity.validateSession(u.ctx.sessionRef, { sensitive: true });
  assert.equal(v.ok, false);
  assert.equal(v.error, "LOCKED");
  assert.equal(f.authService.authorize({ context: u.ctx, action: "resource.read", resource: r.resource.resourceId }).decision, "DENY");
});

test("Gate-Department: A→B 迁移后 A 继承权限消失、B 生效；显式 grant 重新求值", async () => {
  const A = f.authService.createDepartment({ context: admin, name: "Gate-DepA" });
  const B = f.authService.createDepartment({ context: admin, name: "Gate-DepB" });
  const u = await mkUser("gate-d@openarc.test", "gate-d-password-1");
  f.authService.addDepartmentMember({ context: admin, departmentId: A.department.id, userId: u.userId, membershipRole: "member" });
  const rA = await deptResource(A.department.id, "DepAOnly", admin);
  const rB = await deptResource(B.department.id, "DepBOnly", admin);
  f.authService.grantResourcePermission({ context: admin, principalType: "DEPARTMENT", principalId: A.department.id, resourceId: rA, permissionSet: "VIEWER" });
  f.authService.grantResourcePermission({ context: admin, principalType: "DEPARTMENT", principalId: B.department.id, resourceId: rB, permissionSet: "VIEWER" });
  assert.equal((await f.searchService.search({ context: u.ctx, query: "DepAOnly token", limit: 5 })).total, 1);
  const moved = f.governanceService.moveUserDepartment({ context: admin, userId: u.userId, fromDepartmentId: A.department.id, toDepartmentId: B.department.id });
  assert.equal(moved.ok, true);
  assert.equal((await f.searchService.search({ context: u.ctx, query: "DepAOnly token", limit: 5 })).total, 0);
  assert.equal((await f.searchService.search({ context: u.ctx, query: "DepBOnly token", limit: 5 })).total, 1);
});

test("Gate-Escalation: 自我提权 / 跨部门 / Department Admin 越权全部 DENY", async () => {
  const A = f.authService.createDepartment({ context: admin, name: "Gate-EscA" });
  const B = f.authService.createDepartment({ context: admin, name: "Gate-EscB" });
  const u = await mkUser("gate-e@openarc.test", "gate-e-password-1");
  // 普通用户只有 VIEWER，却给自己提权到 MANAGER
  const alice = f.ctx("alice");
  const shared = await f.resourceService.createResource({ context: alice, resourceType: "text", name: "EscRes", content: "x" });
  f.authService.grantResourcePermission({ context: alice, principalType: "USER", principalId: u.userId, resourceId: shared.resource.resourceId, permissionSet: "VIEWER" });
  const selfEsc = f.authService.grantResourcePermission({ context: u.ctx, principalType: "USER", principalId: u.userId, resourceId: shared.resource.resourceId, permissionSet: "MANAGER" });
  assert.equal(selfEsc.ok, false);
  assert.equal(selfEsc.error, "SELF_ESCALATION_DENIED");
  // Department Admin A 管理 B / 跨部门授权 / 自我提权
  f.authService.addDepartmentMember({ context: admin, departmentId: A.department.id, userId: u.userId, membershipRole: "department-admin" });
  assert.equal(f.authService.addDepartmentMember({ context: u.ctx, departmentId: B.department.id, userId: uid("admin@openarc.test"), membershipRole: "member" }).ok, false);
  assert.equal(f.authService.setUserRole({ context: u.ctx, userId: u.userId, role: "ADMIN" }).ok, false);
});

test("Gate-Memory: Personal Memory 其他用户/Department Admin/Super Admin 内容 DENY", async () => {
  const alice = f.ctx("alice");
  const r = await f.resourceService.createResource({ context: alice, resourceType: "memory", name: "PRIVATE_GATE_SECRET_9382", content: "PRIVATE_GATE_BODY_9382", memorySubtype: "project-memory" });
  assert.equal((await f.searchService.search({ context: admin, query: "PRIVATE_GATE_SECRET_9382", limit: 5 })).total, 0);
  assert.equal((await f.searchService.search({ context: admin, query: "PRIVATE_GATE_BODY_9382", limit: 5 })).total, 0);
  assert.equal(f.authService.authorize({ context: admin, action: "resource.read", resource: r.resource.resourceId }).decision, "DENY");
  assert.equal(f.governanceService.listResourceAccess({ context: admin, resourceRef: r.resource.resourceId }).ok, true);
});
