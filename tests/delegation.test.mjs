/**
 * D3-02 · delegation.test
 * Delegation Ceiling 与 No Self Escalation（§12 §13 §69）。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createFixture } from "./authorization-fixtures.mjs";

const f = await createFixture();
after(() => f.close());
const { svc, ctx, resources, created, domain } = f;

test("User self grant manager → DENY", () => {
  const r = svc.grantResourcePermission({ context: ctx("erin", "resource-library"), principalType: "USER", principalId: created.erin, resourceId: resources.designHero.resourceId, permissionSet: "MANAGER" });
  assert.equal(r.ok, false);
  assert.equal(r.error, "SELF_ESCALATION_DENIED");
});

test("Editor grant delete 但自己没有 delete → DENY DELEGATION_EXCEEDS_AUTHORITY", () => {
  const r = svc.grantResourcePermission({ context: ctx("charlie", "resource-library"), principalType: "USER", principalId: created.erin, resourceId: resources.designHero.resourceId, actions: ["resource.delete"] });
  assert.equal(r.ok, false);
  assert.equal(r.error, "DELEGATION_EXCEEDS_AUTHORITY");
});

test("grantor 拥有权限时可授予该权限（charlie read → erin read）", () => {
  const r = svc.grantResourcePermission({ context: ctx("charlie", "resource-library"), principalType: "USER", principalId: created.erin, resourceId: resources.designHero.resourceId, actions: ["resource.read"] });
  assert.equal(r.ok, true);
});

test("grantor 超出自己权限 → DENY（charlie 无 share 权限）", () => {
  const r = svc.grantResourcePermission({ context: ctx("charlie", "resource-library"), principalType: "USER", principalId: created.erin, resourceId: resources.designHero.resourceId, actions: ["resource.share"] });
  assert.equal(r.ok, false);
  assert.equal(r.error, "DELEGATION_EXCEEDS_AUTHORITY");
});

test("Department Admin 跨部门授予（Department principal B）→ DENY", () => {
  const r = svc.grantResourcePermission({ context: ctx("dana", "resource-library"), principalType: "DEPARTMENT", principalId: f.depts.B.id, resourceId: resources.designHero.resourceId, permissionSet: "VIEWER" });
  assert.equal(r.ok, false);
  assert.equal(r.error, "CROSS_DEPARTMENT_DENIED");
});

test("Department Admin 授予他部门用户 → DENY", () => {
  const r = svc.grantResourcePermission({ context: ctx("dana", "resource-library"), principalType: "USER", principalId: created.bob, resourceId: resources.designHero.resourceId, permissionSet: "VIEWER" });
  assert.equal(r.ok, false);
  assert.equal(r.error, "CROSS_DEPARTMENT_DENIED");
});

test("Department Admin 授予本部门用户自己拥有的权限 → ALLOW", () => {
  const r = svc.grantResourcePermission({ context: ctx("dana", "resource-library"), principalType: "USER", principalId: created.erin, resourceId: resources.designHero.resourceId, actions: ["resource.read"] });
  assert.equal(r.ok, true);
});

test("Super Admin 可授予任意组织内权限（不受 ceiling 限制）", () => {
  const r = svc.grantResourcePermission({ context: f.adminCtx, principalType: "USER", principalId: created.erin, resourceId: resources.omega.resourceId, permissionSet: "MANAGER" });
  assert.equal(r.ok, true);
});

test("普通 User 无 manageAccess 时发起授权 → DENY", () => {
  const r = svc.grantResourcePermission({ context: ctx("bob", "resource-library"), principalType: "USER", principalId: created.erin, resourceId: resources.designHero.resourceId, actions: ["resource.read"] });
  assert.equal(r.ok, false);
  assert.ok(["DELEGATION_EXCEEDS_AUTHORITY", "CROSS_DEPARTMENT_DENIED"].includes(r.error));
});
