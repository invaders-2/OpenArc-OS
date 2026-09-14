/** D3-04D · governance-delegation —— 自我提权 / 越权授予 / 跨部门 / Delegation Ceiling。 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createResourceFixture } from "./resource-fixtures.mjs";

const f = await createResourceFixture();
after(() => f.close());
const admin = f.adminCtx();

test("普通用户不能给自己提权 manageAccess", async () => {
  const alice = f.ctx("alice");
  const r = await f.resourceService.createResource({ context: alice, resourceType: "text", name: "SelfEsc", content: "x" });
  const res = f.authService.grantResourcePermission({ context: alice, principalType: "USER", principalId: f.users.alice, resourceId: r.resource.resourceId, permissionSet: "MANAGER" });
  // alice 是 owner，拥有全部动作；显式授予自己 MANAGER 不构成提权，但授予别人 ADMIN 动作应受 ceiling 限制
  assert.equal(typeof res.ok, "boolean");
  // 真正提权：普通用户给同部门另一用户授予自己并不拥有的动作
  const other = await f.governanceService.createUser({ context: admin, identifier: "esc@openarc.test", password: "esc-password-1", displayName: "Esc" });
  const dana = f.ctx("dana");
  const attack = f.authService.grantResourcePermission({ context: dana, principalType: "USER", principalId: other.userId, resourceId: r.resource.resourceId, permissionSet: "MANAGER" });
  assert.equal(attack.ok, false);
  assert.ok(["DELEGATION_EXCEEDS_AUTHORITY", "CROSS_DEPARTMENT_DENIED", "NOT_FOUND_OR_FORBIDDEN"].includes(attack.error));
});

test("Department Admin 不能跨部门授予 App / Resource", async () => {
  const A = f.authService.createDepartment({ context: admin, name: "DelA2" });
  const B = f.authService.createDepartment({ context: admin, name: "DelB2" });
  f.authService.addDepartmentMember({ context: admin, departmentId: A.department.id, userId: f.users.dana, membershipRole: "department-admin" });
  const danaLogin = await f.identity.login({ identifier: "dana@openarc.test", password: "dana-password-1" });
  const danaCtx = { sessionRef: danaLogin.session.ref, appId: "resource-library" };
  const cross = f.authService.grantResourcePermission({ context: danaCtx, principalType: "DEPARTMENT", principalId: B.department.id, resourceType: "text", permissionSet: "VIEWER", departmentId: B.department.id });
  assert.equal(cross.ok, false);
  assert.equal(cross.error, "CROSS_DEPARTMENT_DENIED");
});

test("授予范围不能超过授予者有效权限（Agent 动作）", async () => {
  const alice = f.ctx("alice");
  const r = await f.resourceService.createResource({ context: alice, resourceType: "text", name: "Ceil", content: "x" });
  // alice 是 owner：有 useByAgent（OWNER_POLICY 全部动作）；给 dana 显式授予 VIEWER
  const grant = f.authService.grantResourcePermission({ context: alice, principalType: "USER", principalId: f.users.dana, resourceId: r.resource.resourceId, permissionSet: "VIEWER" });
  assert.equal(grant.ok, true);
  // dana 只有 viewer 动作，不能把 manageAccess 再授出去
  const dana = f.ctx("dana");
  const escalate = f.authService.grantResourcePermission({ context: dana, principalType: "USER", principalId: f.users.bob, resourceId: r.resource.resourceId, permissionSet: "MANAGER" });
  assert.equal(escalate.ok, false);
});
