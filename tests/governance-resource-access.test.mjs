/** D3-04D · governance-resource-access —— 权限来源解释 / Viewer / Revoke / Bulk。 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createResourceFixture } from "./resource-fixtures.mjs";

const f = await createResourceFixture();
after(() => f.close());
const admin = f.adminCtx();

async function deptResource(name) {
  const A = f.authService.createDepartment({ context: admin, name: "RA-" + name });
  f.authService.addDepartmentMember({ context: admin, departmentId: A.department.id, userId: f.users.admin, membershipRole: "member" });
  const imp = await f.resourceService.importText({ context: admin, text: "access token " + name, name, scope: "DEPARTMENT", departmentId: A.department.id });
  return { dept: A.department, rid: imp.resource.resourceId };
}

test("listResourceAccess 解释权限来源，而不只是 Allowed", async () => {
  const { dept, rid } = await deptResource("Src");
  f.authService.grantResourcePermission({ context: admin, principalType: "DEPARTMENT", principalId: dept.id, resourceId: rid, permissionSet: "VIEWER" });
  f.authService.grantResourcePermission({ context: admin, principalType: "USER", principalId: f.users.dana, resourceId: rid, permissionSet: "EDITOR" });
  f.authService.grantAppResourcePermission({ context: admin, appId: "canvas", resourceId: rid, actions: ["resource.read"] });
  const accessRes = f.governanceService.listResourceAccess({ context: admin, resourceRef: rid });
  assert.equal(accessRes.ok, true);
  const sources = accessRes.sources.map((s) => s.source);
  assert.ok(sources.includes("OWNER_POLICY"));
  assert.ok(sources.includes("DEPARTMENT_GRANT"));
  assert.ok(sources.includes("EXPLICIT_USER_GRANT"));
  assert.ok(sources.includes("APP_GRANT"));
  const danaGrant = accessRes.grants.find((g) => g.principalId === f.users.dana);
  assert.ok(danaGrant.actions.includes("resource.edit"));
  assert.ok(danaGrant.actions.includes("resource.read"));
});

test("Viewer 可读不可写；Editor 可写；Revoke 后立即失效", async () => {
  const { dept, rid } = await deptResource("Viewer");
  const created = await f.governanceService.createUser({ context: admin, identifier: "vw@openarc.test", password: "vw-password-1", displayName: "VW" });
  f.authService.addDepartmentMember({ context: admin, departmentId: dept.id, userId: created.userId, membershipRole: "member" });
  const login = await f.identity.login({ identifier: "vw@openarc.test", password: "vw-password-1" });
  const ctx = { sessionRef: login.session.ref, appId: "resource-library" };
  const g = f.authService.grantResourcePermission({ context: admin, principalType: "USER", principalId: created.userId, resourceId: rid, permissionSet: "VIEWER" });
  assert.equal(g.ok, true);
  assert.equal(f.authService.authorize({ context: ctx, action: "resource.read", resource: rid }).decision, "ALLOW");
  assert.equal(f.authService.authorize({ context: ctx, action: "resource.edit", resource: rid }).decision, "DENY");
  const e = f.authService.grantResourcePermission({ context: admin, principalType: "USER", principalId: created.userId, resourceId: rid, permissionSet: "EDITOR" });
  assert.equal(e.ok, true);
  assert.equal(f.authService.authorize({ context: ctx, action: "resource.edit", resource: rid }).decision, "ALLOW");
  const rev = f.authService.revokeResourcePermission({ context: admin, grantId: e.grant.id });
  assert.equal(rev.ok, true);
  assert.equal(f.authService.authorize({ context: ctx, action: "resource.edit", resource: rid }).decision, "DENY");
});

test("bulkGrant 逐项返回 success / denied，不把部分失败显示为全部成功", async () => {
  const { dept, rid } = await deptResource("Bulk");
  const u1 = await f.governanceService.createUser({ context: admin, identifier: "b1@openarc.test", password: "b1-password-1", displayName: "B1" });
  f.authService.addDepartmentMember({ context: admin, departmentId: dept.id, userId: u1.userId, membershipRole: "member" });
  const res = f.governanceService.bulkGrant({ context: admin, principalType: "USER", principalIds: [u1.userId, f.users.bob], resourceId: rid, permissionSet: "VIEWER" });
  assert.equal(res.results.length, 2);
  const ok = res.results.find((r) => r.principalId === u1.userId);
  const denied = res.results.find((r) => r.principalId === f.users.bob);
  assert.equal(ok.status, "success");
  assert.equal(denied.status, "denied");
  assert.equal(res.ok, true);
});
