/** D3-04D · governance-departments —— CRUD / 详情计数 / 删除保护 / Department Admin 边界。 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createResourceFixture } from "./resource-fixtures.mjs";

const f = await createResourceFixture();
after(() => f.close());
const admin = f.adminCtx();

test("创建 / 重命名 / 停用 / 重新启用：Department ID 稳定不变", () => {
  const created = f.authService.createDepartment({ context: admin, name: "Dep1" });
  assert.equal(created.ok, true);
  const id = created.department.id;
  const renamed = f.authService.updateDepartment({ context: admin, departmentId: id, name: "Dep1-Renamed" });
  assert.equal(renamed.ok, true);
  assert.equal(renamed.department.id, id);
  assert.equal(renamed.department.name, "Dep1-Renamed");
  const disabled = f.authService.updateDepartment({ context: admin, departmentId: id, status: "DISABLED" });
  assert.equal(disabled.ok, true);
  const enabled = f.authService.updateDepartment({ context: admin, departmentId: id, status: "ACTIVE" });
  assert.equal(enabled.ok, true);
});

test("部门详情计数来自真实数据（成员 / 资源 / collection）", async () => {
  const A = f.authService.createDepartment({ context: admin, name: "CountA" });
  const created = await f.governanceService.createUser({ context: admin, identifier: "cd1@openarc.test", password: "cd1-password-1", displayName: "CD1" });
  f.authService.addDepartmentMember({ context: admin, departmentId: A.department.id, userId: created.userId, membershipRole: "member" });
  f.authService.addDepartmentMember({ context: admin, departmentId: A.department.id, userId: f.users.admin, membershipRole: "member" });
  await f.resourceService.importText({ context: admin, text: "dept res", name: "DeptRes", scope: "DEPARTMENT", departmentId: A.department.id });
  f.authService.createCollection({ context: admin, name: "DeptCol", departmentId: A.department.id, scope: "DEPARTMENT" });
  const detail = f.governanceService.getDepartmentDetail({ context: admin, departmentId: A.department.id });
  assert.equal(detail.ok, true);
  assert.ok(detail.members.length >= 2);
  assert.equal(detail.resources.length, 1);
  assert.equal(detail.collections.length, 1);
  const list = f.governanceService.listDepartments({ context: admin }).items.find((d) => d.departmentId === A.department.id);
  assert.equal(list.resourceCount, 1);
  assert.equal(list.collectionCount, 1);
});

test("仍有成员 / 资源时禁止删除部门，返回逐项 blockers", async () => {
  const A = f.authService.createDepartment({ context: admin, name: "DelA" });
  assert.equal(f.governanceService.deleteDepartment({ context: admin, departmentId: A.department.id }).ok, true);
  const B = f.authService.createDepartment({ context: admin, name: "DelB" });
  const created = await f.governanceService.createUser({ context: admin, identifier: "db1@openarc.test", password: "db1-password-1", displayName: "DB1" });
  f.authService.addDepartmentMember({ context: admin, departmentId: B.department.id, userId: created.userId, membershipRole: "member" });
  const blocked = f.governanceService.deleteDepartment({ context: admin, departmentId: B.department.id });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, "DEPARTMENT_NOT_EMPTY");
  assert.ok(blocked.blockers.includes("members"));
});

test("Department Admin：只能管理自己部门，跨部门 DENY", async () => {
  const A = f.authService.createDepartment({ context: admin, name: "AdminA" });
  const B = f.authService.createDepartment({ context: admin, name: "AdminB" });
  const dana = f.users.dana;
  f.authService.addDepartmentMember({ context: admin, departmentId: A.department.id, userId: dana, membershipRole: "department-admin" });
  const danaLogin = await f.identity.login({ identifier: "dana@openarc.test", password: "dana-password-1" });
  const danaCtx = { sessionRef: danaLogin.session.ref, appId: "resource-library" };
  const own = f.governanceService.listDepartments({ context: danaCtx });
  assert.equal(own.ok, true);
  assert.ok(own.items.some((d) => d.departmentId === A.department.id));
  assert.equal(own.items.some((d) => d.departmentId === B.department.id), false);
  const other = f.governanceService.getDepartmentDetail({ context: danaCtx, departmentId: B.department.id });
  assert.equal(other.ok, false);
  // 跨部门授权
  const cross = f.authService.addDepartmentMember({ context: danaCtx, departmentId: B.department.id, userId: f.users.alice, membershipRole: "member" });
  assert.equal(cross.ok, false);
  // 自我提权为 ADMIN
  const escalate = f.authService.setUserRole({ context: danaCtx, userId: dana, role: "ADMIN" });
  assert.equal(escalate.ok, false);
});
