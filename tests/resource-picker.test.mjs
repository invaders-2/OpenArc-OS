/** D3-04D · resource-picker —— User ∩ App 交集 / 零泄漏 / choose / token 重新授权。 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createResourceFixture } from "./resource-fixtures.mjs";

const f = await createResourceFixture();
after(() => f.close());
const admin = f.adminCtx();

test("Picker 只显示 User ∩ App ∩ Requested Type 的结果", async () => {
  const A = f.authService.createDepartment({ context: admin, name: "PickA" });
  f.authService.addDepartmentMember({ context: admin, departmentId: A.department.id, userId: f.users.admin, membershipRole: "member" });
  const imp = await f.resourceService.importText({ context: admin, text: "picker needle", name: "PickRes", scope: "DEPARTMENT", departmentId: A.department.id });
  f.authService.grantResourcePermission({ context: admin, principalType: "DEPARTMENT", principalId: A.department.id, resourceId: imp.resource.resourceId, permissionSet: "VIEWER" });
  const adminCtx = admin;
  const q = await f.pickerService.query({ context: adminCtx, appId: "resource-library", query: "picker needle", limit: 10 });
  assert.equal(q.ok, true);
  assert.ok(q.items.some((i) => i.resourceId === imp.resource.resourceId));
  // image-generator 无 grant → 0
  const q2 = await f.pickerService.query({ context: adminCtx, appId: "image-generator", query: "picker needle", limit: 10 });
  assert.equal(q2.total, 0);
  // 请求 image 类型时不得出现 text 资源
  const q3 = await f.pickerService.query({ context: adminCtx, appId: "resource-library", resourceTypes: ["image"], query: "picker needle", limit: 10 });
  assert.equal(q3.total, 0);
});

test("Picker 零泄漏：无权限用户 0 结果且不返回 name / ref", async () => {
  const dana = f.ctx("dana");
  const q = await f.pickerService.query({ context: dana, appId: "resource-library", query: "picker needle", limit: 10 });
  assert.equal(q.ok, true);
  assert.equal(q.total, 0);
  assert.equal(q.items.length, 0);
  assert.equal(JSON.stringify(q).includes("PickRes"), false);
});

test("choose 返回 ResourceRef + selectionToken；撤销 Grant 后 token 立即失效", async () => {
  const alice = f.ctx("alice");
  const r = await f.resourceService.createResource({ context: alice, resourceType: "text", name: "PickRevoke", content: "picker revoke token" });
  const g = f.authService.grantResourcePermission({ context: alice, principalType: "USER", principalId: f.users.admin, resourceId: r.resource.resourceId, permissionSet: "VIEWER" });
  assert.equal(g.ok, true);
  const q = await f.pickerService.query({ context: admin, appId: "resource-library", query: "picker revoke token", limit: 5 });
  const rid = q.items[0].resourceId;
  const choice = f.pickerService.choose({ context: admin, appId: "resource-library", resourceRef: rid, requestedActions: ["resource.read", "resource.view"] });
  assert.equal(choice.ok, true);
  assert.ok(choice.selectionToken.startsWith("pick_"));
  assert.equal(f.pickerService.validateSelection({ context: admin, selectionToken: choice.selectionToken, action: "resource.read" }).ok, true);
  f.authService.revokeResourcePermission({ context: admin, grantId: g.grant.id });
  assert.equal(f.pickerService.validateSelection({ context: admin, selectionToken: choice.selectionToken, action: "resource.read" }).ok, false);
});

test("Picker 不能枚举：猜 resourceRef 的 choose 必须 DENY", async () => {
  const dana = f.ctx("dana");
  const q = await f.pickerService.query({ context: admin, appId: "resource-library", query: "picker needle", limit: 5 });
  const rid = q.items[0].resourceId;
  const res = f.pickerService.choose({ context: dana, appId: "resource-library", resourceRef: rid, requestedActions: ["resource.read"] });
  assert.equal(res.ok, false);
  assert.equal(res.error, "NOT_FOUND_OR_FORBIDDEN");
});
