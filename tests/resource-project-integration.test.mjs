/** D3-04D · resource-project-integration —— Project ResourceRef / 逐资源授权 / 无权不可见。 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createResourceFixture } from "./resource-fixtures.mjs";

const f = await createResourceFixture();
after(() => f.close());
const admin = f.adminCtx();

test("Project 引用 ResourceRef；项目成员仍需逐资源授权", async () => {
  const A = f.authService.createDepartment({ context: admin, name: "PrjA" });
  f.authService.addDepartmentMember({ context: admin, departmentId: A.department.id, userId: f.users.admin, membershipRole: "member" });
  const imp = await f.resourceService.importText({ context: admin, text: "project token", name: "PrjRes", scope: "DEPARTMENT", departmentId: A.department.id });
  f.authService.grantResourcePermission({ context: admin, principalType: "DEPARTMENT", principalId: A.department.id, resourceId: imp.resource.resourceId, permissionSet: "VIEWER" });
  const erin = await f.governanceService.createUser({ context: admin, identifier: "prj@openarc.test", password: "prj-password-1", displayName: "PRJ" });
  f.authService.addDepartmentMember({ context: admin, departmentId: A.department.id, userId: erin.userId, membershipRole: "member" });
  const login = await f.identity.login({ identifier: "prj@openarc.test", password: "prj-password-1" });
  const erinCtx = { sessionRef: login.session.ref, appId: "resource-library" };
  const created = f.projectService.createProject({ context: admin, name: "P" });
  f.projectService.addMember({ context: admin, projectId: created.project.id, userId: erin.userId, role: "editor" });
  assert.equal(f.projectService.addResource({ context: admin, projectId: created.project.id, resourceRef: imp.resource.resourceId }).ok, true);
  const listed = f.projectService.listProjectResources({ context: erinCtx, projectId: created.project.id });
  assert.equal(listed.ok, true);
  assert.equal(listed.items[0].authorized, true);
  // 非成员
  assert.equal(f.projectService.getProject({ context: f.ctx("dana"), projectId: created.project.id }).ok, false);
});

test("项目成员没有 Resource grant → authorized=false 且不泄漏 name", async () => {
  const personal = await f.resourceService.createResource({ context: admin, resourceType: "text", name: "SecretPrjRes", content: "secret" });
  const erin = await f.governanceService.createUser({ context: admin, identifier: "prj2@openarc.test", password: "prj2-password-1", displayName: "PRJ2" });
  const login = await f.identity.login({ identifier: "prj2@openarc.test", password: "prj2-password-1" });
  const erinCtx = { sessionRef: login.session.ref, appId: "resource-library" };
  const created = f.projectService.createProject({ context: admin, name: "P2" });
  f.projectService.addMember({ context: admin, projectId: created.project.id, userId: erin.userId, role: "editor" });
  f.projectService.addResource({ context: admin, projectId: created.project.id, resourceRef: personal.resource.resourceId });
  const listed = f.projectService.listProjectResources({ context: erinCtx, projectId: created.project.id });
  assert.equal(listed.items[0].authorized, false);
  assert.equal(JSON.stringify(listed).includes("SecretPrjRes"), false);
});

test("撤销 Resource grant 后下一次项目访问立即 DENY 资源", async () => {
  const A = f.authService.createDepartment({ context: admin, name: "PrjRev" });
  f.authService.addDepartmentMember({ context: admin, departmentId: A.department.id, userId: f.users.admin, membershipRole: "member" });
  f.authService.addDepartmentMember({ context: admin, departmentId: A.department.id, userId: f.users.dana, membershipRole: "member" });
  const imp = await f.resourceService.importText({ context: admin, text: "revoke project", name: "PrjRevRes", scope: "DEPARTMENT", departmentId: A.department.id });
  const g = f.authService.grantResourcePermission({ context: admin, principalType: "DEPARTMENT", principalId: A.department.id, resourceId: imp.resource.resourceId, permissionSet: "VIEWER" });
  const danaLogin = await f.identity.login({ identifier: "dana@openarc.test", password: "dana-password-1" });
  const danaCtx = { sessionRef: danaLogin.session.ref, appId: "resource-library" };
  const created = f.projectService.createProject({ context: admin, name: "P3" });
  f.projectService.addMember({ context: admin, projectId: created.project.id, userId: f.users.dana, role: "viewer" });
  f.projectService.addResource({ context: admin, projectId: created.project.id, resourceRef: imp.resource.resourceId });
  assert.equal(f.projectService.listProjectResources({ context: danaCtx, projectId: created.project.id }).items[0].authorized, true);
  f.authService.revokeResourcePermission({ context: admin, grantId: g.grant.id });
  assert.equal(f.projectService.listProjectResources({ context: danaCtx, projectId: created.project.id }).items[0].authorized, false);
});
