/**
 * D3-02 · department-policy.test
 * Department Admin 边界 / Super Admin 治理 / Department Inheritance（§32 §69）。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createFixture } from "./authorization-fixtures.mjs";

const f = await createFixture();
after(() => f.close());
const { svc, ctx, resources, created, depts, domain } = f;

test("Department A inherited VIEWER：read ALLOW / edit DENY", () => {
  const read = svc.authorize({ context: ctx("erin", "resource-library"), action: domain.ACTION.READ, resource: resources.designHero.resourceId });
  const edit = svc.authorize({ context: ctx("erin", "resource-library"), action: domain.ACTION.EDIT, resource: resources.designHero.resourceId });
  assert.equal(read.decision, "ALLOW");
  assert.equal(edit.decision, "DENY");
});

test("Super Admin manage user permission → ALLOW", () => {
  const r = svc.grantResourcePermission({ context: f.adminCtx, principalType: "USER", principalId: created.alice, resourceId: resources.omega.resourceId, permissionSet: "VIEWER" });
  assert.equal(r.ok, true);
});

test("Department Admin manage own department → ALLOW", () => {
  const r = svc.addDepartmentMember({ context: ctx("dana", "resource-library"), departmentId: depts.A.id, userId: created.bob, membershipRole: "member" });
  assert.equal(r.ok, true);
  assert.equal(r.membership.department_id, depts.A.id);
});

test("Department Admin manage other department → DENY", () => {
  const r = svc.addDepartmentMember({ context: ctx("dana", "resource-library"), departmentId: depts.B.id, userId: created.alice, membershipRole: "member" });
  assert.equal(r.ok, false);
  assert.equal(r.error, "CROSS_DEPARTMENT_DENIED");
});

test("Department Admin self elevate（给自己 department-admin）→ DENY", () => {
  const r = svc.addDepartmentMember({ context: ctx("dana", "resource-library"), departmentId: depts.A.id, userId: created.dana, membershipRole: "department-admin" });
  assert.equal(r.ok, false);
  assert.equal(r.error, "SELF_ESCALATION_DENIED");
});

test("Department Admin self elevate to Super Admin → DENY NOT_SUPER_ADMIN", () => {
  const r = svc.setUserRole({ context: ctx("dana", "resource-library"), userId: created.dana, role: "ADMIN" });
  assert.equal(r.ok, false);
  assert.equal(r.error, "NOT_SUPER_ADMIN");
});

test("普通 User 不能创建 Department → DENY NOT_SUPER_ADMIN", () => {
  const r = svc.createDepartment({ context: ctx("alice", "resource-library"), name: "Sneaky" });
  assert.equal(r.ok, false);
  assert.equal(r.error, "NOT_SUPER_ADMIN");
});

test("Department Admin 只能看到自己部门的 Department 列表", () => {
  const all = svc.listDepartments({ context: f.adminCtx });
  const own = svc.listDepartments({ context: ctx("dana", "resource-library") });
  assert.equal(all.items.length, 2);
  assert.equal(own.items.length, 1);
  assert.equal(own.items[0].id, depts.A.id);
});

test("Department member 移除后下一请求立即失效（§32）", () => {
  const before = svc.authorize({ context: ctx("charlie", "resource-library"), action: domain.ACTION.READ, resource: resources.designHero.resourceId });
  assert.equal(before.decision, "ALLOW");
  const removed = svc.removeDepartmentMember({ context: f.adminCtx, departmentId: depts.A.id, userId: created.charlie });
  assert.equal(removed.ok, true);
  const afterR = svc.authorize({ context: ctx("charlie", "resource-library"), action: domain.ACTION.READ, resource: resources.designHero.resourceId });
  assert.equal(afterR.decision, "DENY");
  svc.addDepartmentMember({ context: f.adminCtx, departmentId: depts.A.id, userId: created.charlie, membershipRole: "member" });
});

test("重复移除成员 → 幂等 NO_CHANGE", () => {
  const first = svc.removeDepartmentMember({ context: f.adminCtx, departmentId: depts.B.id, userId: created.alice });
  const second = svc.removeDepartmentMember({ context: f.adminCtx, departmentId: depts.B.id, userId: created.alice });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.changed, false);
  assert.equal(second.reasonCode, "NO_CHANGE");
});
