/**
 * D3-02 · inheritance.test
 * Department 继承 / Reparent / Department Transfer（§32 §33 §34 §70）。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createFixture } from "./authorization-fixtures.mjs";

const f = await createFixture();
after(() => f.close());
const { svc, ctx, resources, created, depts, collections, domain } = f;

test("Department A → Collection A → Resource A：继承 VIEWER（read ALLOW / edit DENY）", () => {
  const read = svc.authorize({ context: ctx("erin", "resource-library"), action: domain.ACTION.READ, resource: resources.designHero.resourceId });
  const edit = svc.authorize({ context: ctx("erin", "resource-library"), action: domain.ACTION.EDIT, resource: resources.designHero.resourceId });
  assert.equal(read.decision, "ALLOW");
  assert.equal(edit.decision, "DENY");
});

test("Reparent A → B：A 的 inherited access 消失，B policy 重新计算", () => {
  const before = svc.authorize({ context: ctx("erin", "resource-library"), action: domain.ACTION.READ, resource: resources.designHero.resourceId });
  assert.equal(before.decision, "ALLOW");
  const rep = svc.reparentResource({ context: f.adminCtx, resourceId: resources.designHero.resourceId, departmentId: depts.B.id, collectionId: null });
  assert.equal(rep.ok, true);
  assert.equal(rep.resource.departmentId, depts.B.id);
  const afterA = svc.authorize({ context: ctx("erin", "resource-library"), action: domain.ACTION.READ, resource: resources.designHero.resourceId });
  assert.equal(afterA.decision, "DENY");
  const g = svc.grantResourcePermission({ context: f.adminCtx, principalType: "DEPARTMENT", principalId: depts.B.id, resourceId: resources.designHero.resourceId, permissionSet: "VIEWER" });
  assert.equal(g.ok, true);
  const afterB = svc.authorize({ context: ctx("bob", "resource-library"), action: domain.ACTION.READ, resource: resources.designHero.resourceId });
  assert.equal(afterB.decision, "ALLOW");
  assert.ok(afterB.allowSources.includes("DEPARTMENT_GRANT"));
});

test("User Department Transfer A→B：A inherited grant 立即消失，B policy 生效", () => {
  // 先给 B 的 collection 一个 VIEWER，使 B 成员可读 deptBImage
  svc.grantResourcePermission({ context: f.adminCtx, principalType: "DEPARTMENT", principalId: depts.B.id, collectionId: collections.marketing.id, permissionSet: "VIEWER" });
  const aliceBefore = svc.authorize({ context: ctx("alice", "resource-library"), action: domain.ACTION.READ, resource: resources.deptBImage.resourceId });
  assert.equal(aliceBefore.decision, "DENY");
  // 转部门
  svc.removeDepartmentMember({ context: f.adminCtx, departmentId: depts.A.id, userId: created.alice });
  svc.addDepartmentMember({ context: f.adminCtx, departmentId: depts.B.id, userId: created.alice, membershipRole: "member" });
  const aliceAfter = svc.authorize({ context: ctx("alice", "resource-library"), action: domain.ACTION.READ, resource: resources.deptBImage.resourceId });
  assert.equal(aliceAfter.decision, "ALLOW");
});

test("显式 USER grant 在不适用的 scope 下不生效（不静默沿用）", () => {
  // Department A 专属资源，显式授权给 Department B 的成员 bob —— 但 bob 不是 A 成员，
  // 按 §34 规则该 grant 在新 scope 下非法，必须拒绝而不是静默沿用。
  const reg = svc.registerResource({ context: f.adminCtx, resourceId: "res_deptAonly_fixture_1", resourceType: "document", scope: "DEPARTMENT", departmentId: depts.A.id, name: "A Only" });
  assert.equal(reg.ok, true);
  const rid = reg.resource.resourceId;
  const g = svc.grantResourcePermission({ context: f.adminCtx, principalType: "USER", principalId: created.bob, resourceId: rid, permissionSet: "VIEWER" });
  assert.equal(g.ok, true);
  const r = svc.authorize({ context: ctx("bob", "resource-library"), action: domain.ACTION.READ, resource: rid });
  assert.equal(r.decision, "DENY");
  assert.equal(r.reasonCode, "DEPARTMENT_DENIED");
});
