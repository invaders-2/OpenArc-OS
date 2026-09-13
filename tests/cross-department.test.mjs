/**
 * D3-02 · cross-department.test
 * Department 边界：读 / 写 / 授权全部 DENY（§35 §69）。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createFixture } from "./authorization-fixtures.mjs";

const f = await createFixture();
after(() => f.close());
const { svc, ctx, resources, created, domain } = f;

test("Team B User 对 Team A Resource：read / edit 全部 DENY", () => {
  const read = svc.authorize({ context: ctx("bob", "resource-library"), action: domain.ACTION.READ, resource: resources.designHero.resourceId });
  const edit = svc.authorize({ context: ctx("bob", "resource-library"), action: domain.ACTION.EDIT, resource: resources.designHero.resourceId });
  assert.equal(read.decision, "DENY");
  assert.equal(edit.decision, "DENY");
});

test("Team B User 对 Team A Resource 发起 grant → DENY", () => {
  const r = svc.grantResourcePermission({ context: ctx("bob", "resource-library"), principalType: "USER", principalId: created.erin, resourceId: resources.designHero.resourceId, permissionSet: "VIEWER" });
  assert.equal(r.ok, false);
});

test("Department Admin 不得给 App 授权其他部门 → DENY NOT_SUPER_ADMIN", () => {
  const r = svc.grantAppResourcePermission({ context: ctx("dana", "resource-library"), appId: "photoshop", departmentId: f.depts.B.id, actions: ["resource.read"] });
  assert.equal(r.ok, false);
  assert.equal(r.error, "NOT_SUPER_ADMIN");
});

test("Department Admin 不得 Reparent 到其他部门 → DENY", () => {
  const r = svc.reparentResource({ context: ctx("dana", "resource-library"), resourceId: resources.designHero.resourceId, departmentId: f.depts.B.id });
  assert.equal(r.ok, false);
  assert.equal(r.error, "CROSS_DEPARTMENT_DENIED");
});
