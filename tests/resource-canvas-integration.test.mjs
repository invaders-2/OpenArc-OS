/** D3-04D · resource-canvas-integration —— ResourceRef 节点 / PIN_VERSION / FOLLOW_LATEST / 真实状态。 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createResourceFixture } from "./resource-fixtures.mjs";

const f = await createResourceFixture();
after(() => f.close());
const admin = f.adminCtx();

let seq = 0;
async function setup() {
  seq += 1;
  const A = f.authService.createDepartment({ context: admin, name: "CvsA" + seq + "-" + Math.random().toString(36).slice(2, 6) });
  f.authService.addDepartmentMember({ context: admin, departmentId: A.department.id, userId: f.users.admin, membershipRole: "member" });
  const imp = await f.resourceService.importText({ context: admin, text: "canvas body", name: "CvsRes", scope: "DEPARTMENT", departmentId: A.department.id });
  f.authService.grantResourcePermission({ context: admin, principalType: "DEPARTMENT", principalId: A.department.id, resourceId: imp.resource.resourceId, permissionSet: "VIEWER" });
  return { dept: A.department, rid: imp.resource.resourceId };
}

test("Canvas 节点保存 ResourceRef；PIN_VERSION 不静默跟随新版本", async () => {
  const { rid } = await setup();
  const board = f.canvasService.createBoard({ context: admin, name: "B" });
  const node = f.canvasService.addResourceNode({ context: admin, boardId: board.board.id, resourceRef: rid });
  assert.equal(node.ok, true);
  assert.equal(node.node.version_mode, "PIN_VERSION");
  assert.equal(node.node.resource_id, rid);
  assert.equal(JSON.stringify(node).includes("/"), false, "节点不得包含路径");
  await f.resourceService.replaceText({ context: admin, resourceRef: rid, text: "canvas body v2", expectedVersion: 1 });
  const state = f.canvasService.getBoard({ context: admin, boardId: board.board.id }).nodes[0];
  assert.equal(state.state, "VERSION_AVAILABLE");
  assert.equal(state.resourceVersion, 1);
  assert.equal(state.latestVersion, 2);
  // 显式 Update to latest
  assert.equal(f.canvasService.updateNodeToLatest({ context: admin, nodeId: node.node.id }).ok, true);
  const pinned = f.canvasService.getBoard({ context: admin, boardId: board.board.id }).nodes[0];
  assert.equal(pinned.state, "AVAILABLE");
  assert.equal(pinned.resourceVersion, 2);
});

test("FOLLOW_LATEST 节点自动使用最新版本", async () => {
  const { rid } = await setup();
  const board = f.canvasService.createBoard({ context: admin, name: "B2" });
  const node = f.canvasService.addResourceNode({ context: admin, boardId: board.board.id, resourceRef: rid, versionMode: "FOLLOW_LATEST" });
  assert.equal(node.ok, true);
  await f.resourceService.replaceText({ context: admin, resourceRef: rid, text: "v2", expectedVersion: 1 });
  await f.resourceService.replaceText({ context: admin, resourceRef: rid, text: "v3", expectedVersion: 2 });
  const state = f.canvasService.getBoard({ context: admin, boardId: board.board.id }).nodes[0];
  assert.equal(state.state, "AVAILABLE");
  assert.equal(state.followsLatest, true);
  assert.equal(state.effectiveVersion, 3);
});

test("Trash -> UNAVAILABLE；Permanent Delete -> DELETED；权限撤销 -> UNAUTHORIZED 且不泄漏 name", async () => {
  const { dept, rid } = await setup();
  const erin = await f.governanceService.createUser({ context: admin, identifier: "cvs@openarc.test", password: "cvs-password-1", displayName: "CVS" });
  f.authService.addDepartmentMember({ context: admin, departmentId: dept.id, userId: erin.userId, membershipRole: "member" });
  const login = await f.identity.login({ identifier: "cvs@openarc.test", password: "cvs-password-1" });
  const erinCtx = { sessionRef: login.session.ref, appId: "resource-library" };
  const board = f.canvasService.createBoard({ context: erinCtx, name: "ErinBoard" });
  const node = f.canvasService.addResourceNode({ context: erinCtx, boardId: board.board.id, resourceRef: rid });
  assert.equal(node.ok, true);
  // trashed
  f.resourceService.delete({ context: admin, resourceRef: rid });
  assert.equal(f.canvasService.getBoard({ context: erinCtx, boardId: board.board.id }).nodes[0].state, "UNAVAILABLE");
  f.resourceService.restore({ context: admin, resourceRef: rid });
  // revoke grant
  const access = f.governanceService.listResourceAccess({ context: admin, resourceRef: rid });
  f.authService.revokeResourcePermission({ context: admin, grantId: access.grants.find((g) => g.principalType === "DEPARTMENT").grantId });
  const unauth = f.canvasService.getBoard({ context: erinCtx, boardId: board.board.id }).nodes[0];
  assert.equal(unauth.state, "UNAUTHORIZED");
  assert.equal(unauth.resource, undefined);
  assert.equal(JSON.stringify(unauth).includes("CvsRes"), false);
  // permanent delete
  f.resourceService.permanentDelete({ context: admin, resourceRef: rid });
  assert.equal(f.canvasService.getBoard({ context: admin, boardId: board.board.id }).nodes[0].state, "DELETED");
});
