/** D3-04D · resource-picker-authz —— Resource Type / Collection / Department Ceiling + Memory 排除 + stale token。 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createResourceFixture } from "./resource-fixtures.mjs";

const f = await createResourceFixture();
after(() => f.close());
const admin = f.adminCtx();

async function seedImage(name, deptId) {
  const png = f.writeSource(name + ".png", Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 5)]));
  const imp = await f.resourceService.importManaged({ context: admin, sourcePath: png, name: name + ".png", mimeType: "image/png", scope: deptId ? "DEPARTMENT" : "PERSONAL", departmentId: deptId || null });
  return imp.resource.resourceId;
}

test("App 只授权 Images：Picker 请求 text 时不得出现 text 资源", async () => {
  const alice = f.ctx("alice");
  const text = await f.resourceService.createResource({ context: alice, resourceType: "text", name: "OnlyText", content: "type ceiling" });
  f.governanceService.grantAppAccess({ context: admin, appId: "image-generator", resourceId: text.resource.resourceId, actions: ["resource.read", "resource.view", "resource.search"] });
  const q = await f.pickerService.query({ context: alice, appId: "image-generator", resourceTypes: ["image"], query: "type ceiling", limit: 10 });
  assert.equal(q.total, 0);
  const q2 = await f.pickerService.query({ context: alice, appId: "image-generator", query: "type ceiling", limit: 10 });
  assert.ok(q2.items.every((i) => i.resourceType === "text"));
});

test("App 只授权 Department A：Department B 资源不出现", async () => {
  const A = f.authService.createDepartment({ context: admin, name: "CeilA" });
  const B = f.authService.createDepartment({ context: admin, name: "CeilB" });
  f.authService.addDepartmentMember({ context: admin, departmentId: A.department.id, userId: f.users.admin, membershipRole: "member" });
  f.authService.addDepartmentMember({ context: admin, departmentId: B.department.id, userId: f.users.admin, membershipRole: "member" });
  const imgA = await seedImage("ceilA", A.department.id);
  const imgB = await seedImage("ceilB", B.department.id);
  f.authService.grantResourcePermission({ context: admin, principalType: "DEPARTMENT", principalId: A.department.id, resourceId: imgA, permissionSet: "VIEWER" });
  f.authService.grantResourcePermission({ context: admin, principalType: "DEPARTMENT", principalId: B.department.id, resourceId: imgB, permissionSet: "VIEWER" });
  // 内置 canvas 有全局 baseline；先撤销全部，再只授权 A 部门（模拟"该 App 只被允许 A 部门"）
  for (const g of f.store.appGrantsForApp("canvas")) {
    f.governanceService.revokeAppAccess({ context: admin, grantId: g.id });
  }
  f.governanceService.grantAppAccess({ context: admin, appId: "canvas", departmentId: A.department.id, actions: ["resource.read", "resource.view", "resource.search"] });
  const q = await f.pickerService.query({ context: admin, appId: "canvas", query: "png", limit: 10 });
  const ids = q.items.map((i) => i.resourceId);
  assert.ok(ids.includes(imgA));
  assert.equal(ids.includes(imgB), false);
});

test("Memory 默认不进入第三方 App Picker", async () => {
  const alice = f.ctx("alice");
  await f.resourceService.createResource({ context: alice, resourceType: "memory", name: "PickMemory", content: "pickermemory", memorySubtype: "project-memory" });
  // image-generator 有全局 read（无 memory）
  f.governanceService.grantAppAccess({ context: admin, appId: "image-generator", actions: ["resource.read", "resource.view", "resource.search"] });
  const q = await f.pickerService.query({ context: alice, appId: "image-generator", query: "pickermemory", limit: 10 });
  assert.equal(q.total, 0);
});

test("Picker 打开后 App 被禁用：token 校验立即 DENY", async () => {
  const alice = f.ctx("alice");
  const r = await f.resourceService.createResource({ context: alice, resourceType: "text", name: "StaleToken", content: "stalepicker" });
  f.governanceService.grantAppAccess({ context: admin, appId: "canvas", resourceId: r.resource.resourceId, actions: ["resource.read", "resource.view", "resource.search"] });
  const choice = f.pickerService.choose({ context: alice, appId: "canvas", resourceRef: r.resource.resourceId, requestedActions: ["resource.read"] });
  assert.equal(choice.ok, true);
  f.governanceService.setAppStatus({ context: admin, appId: "canvas", status: "disabled" });
  assert.equal(f.pickerService.validateSelection({ context: alice, selectionToken: choice.selectionToken, action: "resource.read" }).ok, false);
  f.governanceService.setAppStatus({ context: admin, appId: "canvas", status: "enabled" });
});
