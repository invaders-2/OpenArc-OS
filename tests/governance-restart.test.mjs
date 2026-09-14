/** D3-04D · governance-restart —— 部门 / 成员 / 授权 / App / 项目 / 画布 / 所有权 重启后一致。 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createResourceFixture, reopenResourceRuntime, tempRoot } from "./resource-fixtures.mjs";

const cleanups = [];
after(() => { for (const d of cleanups) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } });

test("治理状态重启后一致，且搜索范围不依赖内存缓存", async () => {
  const root = tempRoot("oa-d3-04d-restart");
  cleanups.push(root);
  const dbPath = path.join(root, "identity.db");
  const storeRoot = path.join(root, "library");
  const f = await createResourceFixture({ dbPath, storeRoot });
  const admin = f.adminCtx();
  const A = f.authService.createDepartment({ context: admin, name: "RstA" });
  const created = await f.governanceService.createUser({ context: admin, identifier: "rst@openarc.test", password: "rst-password-1", displayName: "RST" });
  f.authService.addDepartmentMember({ context: admin, departmentId: A.department.id, userId: created.userId, membershipRole: "member" });
  f.authService.addDepartmentMember({ context: admin, departmentId: A.department.id, userId: f.users.admin, membershipRole: "member" });
  const imp = await f.resourceService.importText({ context: admin, text: "restart token", name: "RstRes", scope: "DEPARTMENT", departmentId: A.department.id });
  f.authService.grantResourcePermission({ context: admin, principalType: "DEPARTMENT", principalId: A.department.id, resourceId: imp.resource.resourceId, permissionSet: "VIEWER" });
  await f.searchService.search({ context: admin, query: "restart token", limit: 5 });
  f.governanceService.grantAppAccess({ context: admin, appId: "canvas", resourceId: imp.resource.resourceId, actions: ["resource.read", "resource.view", "resource.search"] });
  const project = f.projectService.createProject({ context: admin, name: "RstP" });
  f.projectService.addMember({ context: admin, projectId: project.project.id, userId: created.userId, role: "viewer" });
  f.projectService.addResource({ context: admin, projectId: project.project.id, resourceRef: imp.resource.resourceId });
  const board = f.canvasService.createBoard({ context: admin, name: "RstB" });
  const node = f.canvasService.addResourceNode({ context: admin, boardId: board.board.id, resourceRef: imp.resource.resourceId });
  f.governanceService.transferOwnership({ context: admin, resourceId: imp.resource.resourceId, newOwnerUserId: created.userId });
  const snapshot = { rid: imp.resource.resourceId, projectId: project.project.id, boardId: board.board.id, nodeId: node.node.id, userId: created.userId };
  f.identity.close();

  const re = reopenResourceRuntime({ dbPath, storeRoot });
  const login = await re.identity.login({ identifier: "admin@openarc.test", password: "admin-password-1" });
  const adminCtx = { sessionRef: login.session.ref, appId: "resource-library" };
  const rstLogin = await re.identity.login({ identifier: "rst@openarc.test", password: "rst-password-1" });
  const rstCtx = { sessionRef: rstLogin.session.ref, appId: "resource-library" };
  const depts = re.governanceService.listDepartments({ context: adminCtx });
  assert.ok(depts.items.some((d) => d.name === "RstA"));
  const access = re.governanceService.listResourceAccess({ context: adminCtx, resourceRef: snapshot.rid });
  assert.equal(access.ok, true);
  assert.equal(access.resource.ownerUserId, snapshot.userId);
  const project2 = re.projectService.getProject({ context: rstCtx, projectId: snapshot.projectId });
  assert.equal(project2.ok, true);
  const resources = re.projectService.listProjectResources({ context: rstCtx, projectId: snapshot.projectId });
  assert.equal(resources.items[0].authorized, true);
  const board2 = re.canvasService.getBoard({ context: adminCtx, boardId: snapshot.boardId });
  assert.equal(board2.nodes[0].nodeId, snapshot.nodeId);
  const search = await re.searchService.search({ context: rstCtx, query: "restart token", limit: 5 });
  assert.equal(search.total, 1);
  re.identity.close();
});
