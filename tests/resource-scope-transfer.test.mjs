/** D3-04D · resource-scope-transfer —— Scope 变更 / 影响预览 / Ownership Transfer。 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createResourceFixture } from "./resource-fixtures.mjs";

const f = await createResourceFixture();
after(() => f.close());
const admin = f.adminCtx();

test("Scope 变更影响预览：will gain / will lose / grants affected", async () => {
  const A = f.authService.createDepartment({ context: admin, name: "ScA" });
  f.authService.addDepartmentMember({ context: admin, departmentId: A.department.id, userId: f.users.dana, membershipRole: "member" });
  const alice = f.ctx("alice");
  const r = await f.resourceService.createResource({ context: alice, resourceType: "text", name: "ScopeRes", content: "scope token" });
  const impact = f.governanceService.previewScopeChange({ context: admin, resourceRef: r.resource.resourceId, scope: "DEPARTMENT", departmentId: A.department.id });
  assert.equal(impact.ok, true);
  assert.equal(impact.impact.fromScope, "PERSONAL");
  assert.equal(impact.impact.toScope, "DEPARTMENT");
  assert.ok(impact.impact.willGain.some((u) => u.userId === f.users.dana));
  // 变更后 dana（部门成员）可通过部门 grant 访问
  const changed = f.governanceService.changeScope({ context: admin, resourceRef: r.resource.resourceId, scope: "DEPARTMENT", departmentId: A.department.id });
  assert.equal(changed.ok, true);
  assert.equal(changed.resource.scope, "DEPARTMENT");
  assert.equal(changed.resource.departmentId, A.department.id);
  f.authService.grantResourcePermission({ context: admin, principalType: "DEPARTMENT", principalId: A.department.id, resourceId: r.resource.resourceId, permissionSet: "VIEWER" });
  const danaLogin = await f.identity.login({ identifier: "dana@openarc.test", password: "dana-password-1" });
  const danaCtx = { sessionRef: danaLogin.session.ref, appId: "resource-library" };
  assert.equal((await f.searchService.search({ context: danaCtx, query: "scope token", limit: 5 })).total, 1);
});

test("Ownership Transfer：ResourceRef / version 不变；旧 owner 失去 OWNER_POLICY", async () => {
  const alice = f.ctx("alice");
  const r = await f.resourceService.createResource({ context: alice, resourceType: "text", name: "Owned", content: "owned token" });
  const ref = r.resource.resourceRef;
  const version = f.resourceStore.resourceRowById(r.resource.resourceId).version;
  assert.equal(f.authService.authorize({ context: alice, action: "resource.manageAccess", resource: r.resource.resourceId }).decision, "ALLOW");
  const transferred = f.governanceService.transferOwnership({ context: admin, resourceId: r.resource.resourceId, newOwnerUserId: f.users.dana });
  assert.equal(transferred.ok, true);
  assert.equal(transferred.resource.resourceRef, ref);
  assert.equal(f.resourceStore.resourceRowById(r.resource.resourceId).version, version);
  assert.equal(f.authService.authorize({ context: alice, action: "resource.manageAccess", resource: r.resource.resourceId }).decision, "DENY");
  assert.equal(f.authService.authorize({ context: f.ctx("dana"), action: "resource.manageAccess", resource: r.resource.resourceId }).decision, "ALLOW");
  // Audit 记录了 owner 变化
  const audit = f.governanceService.listAudit({ context: admin, filter: { action: "governance.transferOwnership" } });
  assert.ok(audit.items.length >= 1);
});

test("批量 Ownership Transfer 逐项结果", async () => {
  const a = await f.resourceService.createResource({ context: f.ctx("alice"), resourceType: "text", name: "BT1", content: "x" });
  const b = await f.resourceService.createResource({ context: f.ctx("alice"), resourceType: "text", name: "BT2", content: "x" });
  const res = f.governanceService.bulkTransferOwnership({ context: admin, resourceIds: [a.resource.resourceId, b.resource.resourceId, "res_does_not_exist"], newOwnerUserId: f.users.dana });
  assert.equal(res.results.length, 3);
  assert.equal(res.results[0].status, "success");
  assert.equal(res.results[2].status, "denied");
});
