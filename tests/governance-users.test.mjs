/** D3-04D · governance-users —— 创建 / 禁用 / 启用 / 重置 / 迁移 / 列表。 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createResourceFixture } from "./resource-fixtures.mjs";

const f = await createResourceFixture();
after(() => f.close());
const admin = f.adminCtx();

test("Super Admin 创建子用户并出现在治理列表（无 password 字段）", async () => {
  const created = await f.governanceService.createUser({ context: admin, identifier: "g1@openarc.test", password: "g1-password-1", displayName: "G1" });
  assert.equal(created.ok, true);
  const list = f.governanceService.listUsers({ context: admin });
  assert.equal(list.ok, true);
  const item = list.items.find((u) => u.userId === created.userId);
  assert.ok(item);
  assert.equal(item.status, "ACTIVE");
  const json = JSON.stringify(list);
  for (const secret of ["password_hash", "password_salt", "password_params", "token_hash"]) {
    assert.equal(json.includes(secret), false, "治理列表不得包含 " + secret);
  }
});

test("Disable 立即拒绝新登录与资源操作；Re-enable 恢复", async () => {
  const created = await f.governanceService.createUser({ context: admin, identifier: "g2@openarc.test", password: "g2-password-1", displayName: "G2" });
  const login1 = await f.identity.login({ identifier: "g2@openarc.test", password: "g2-password-1" });
  const ctx = { sessionRef: login1.session.ref, appId: "resource-library" };
  assert.equal((await f.resourceService.createResource({ context: ctx, resourceType: "text", name: "Before", content: "x" })).ok, true);
  const off = f.governanceService.setUserStatus({ context: admin, userId: created.userId, status: "DISABLED" });
  assert.equal(off.ok, true);
  assert.equal((await f.identity.login({ identifier: "g2@openarc.test", password: "g2-password-1" })).ok, false);
  assert.equal(f.resourceService.get({ context: ctx, resourceRef: "res_x" }).ok, false);
  assert.equal((await f.resourceService.createResource({ context: ctx, resourceType: "text", name: "After", content: "x" })).ok, false);
  const on = f.governanceService.setUserStatus({ context: admin, userId: created.userId, status: "ACTIVE" });
  assert.equal(on.ok, true);
  assert.equal((await f.identity.login({ identifier: "g2@openarc.test", password: "g2-password-1" })).ok, true);
});

test("口令重置：返回一次性临时口令、撤销全部 session、强制旧口令失效", async () => {
  const created = await f.governanceService.createUser({ context: admin, identifier: "g3@openarc.test", password: "g3-password-1", displayName: "G3" });
  const before = await f.identity.login({ identifier: "g3@openarc.test", password: "g3-password-1" });
  assert.equal(before.ok, true);
  const reset = await f.governanceService.initiatePasswordReset({ context: admin, userId: created.userId });
  assert.equal(reset.ok, true);
  assert.ok(reset.temporaryPassword.length >= 8);
  assert.ok(reset.revokedSessions >= 1);
  assert.equal((await f.identity.login({ identifier: "g3@openarc.test", password: "g3-password-1" })).ok, false);
  assert.equal((await f.identity.login({ identifier: "g3@openarc.test", password: reset.temporaryPassword })).ok, true);
  // 治理响应不得包含旧 verifier / hash
  assert.equal(JSON.stringify(reset).includes("password_hash"), false);
});

test("普通用户不能调用治理命令（无权限）", async () => {
  const alice = f.ctx("alice");
  for (const fn of ["listUsers", "listDepartments", "listApps", "listAudit"]) {
    const res = f.governanceService[fn]({ context: alice });
    assert.equal(res.ok, false, fn + " 应拒绝普通用户");
  }
});

test("moveUserDepartment：旧部门继承权限消失、新部门生效", async () => {
  const A = f.authService.createDepartment({ context: admin, name: "MoveA" });
  const B = f.authService.createDepartment({ context: admin, name: "MoveB" });
  const created = await f.governanceService.createUser({ context: admin, identifier: "m1@openarc.test", password: "m1-password-1", displayName: "M1" });
  f.authService.addDepartmentMember({ context: admin, departmentId: A.department.id, userId: created.userId, membershipRole: "member" });
  const moved = f.governanceService.moveUserDepartment({ context: admin, userId: created.userId, fromDepartmentId: A.department.id, toDepartmentId: B.department.id });
  assert.equal(moved.ok, true);
  assert.equal(f.store.membershipByPair(A.department.id, created.userId), null);
  assert.equal(f.store.membershipByPair(B.department.id, created.userId).status, "ACTIVE");
});
