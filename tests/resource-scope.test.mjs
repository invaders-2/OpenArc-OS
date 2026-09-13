/**
 * D3-02 · resource-scope.test
 * PERSONAL / DEPARTMENT / ORGANIZATION 三个 scope 的授权边界（§17 §31 §70）。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createFixture } from "./authorization-fixtures.mjs";

const f = await createFixture();
after(() => f.close());
const { svc, ctx, resources, created, depts, collections, domain } = f;

test("PERSONAL：owner read → ALLOW via OWNER_POLICY", () => {
  const r = svc.authorize({ context: ctx("alice", "resource-library"), action: domain.ACTION.READ, resource: resources.alpha.resourceId });
  assert.equal(r.decision, "ALLOW");
  assert.ok(r.allowSources.includes("OWNER_POLICY"));
});

test("PERSONAL：非 owner 无 grant → DENY", () => {
  const r = svc.authorize({ context: ctx("bob", "resource-library"), action: domain.ACTION.READ, resource: resources.alpha.resourceId });
  assert.equal(r.decision, "DENY");
});

test("PERSONAL：显式 USER grant 可分享", () => {
  const g = svc.grantResourcePermission({ context: f.adminCtx, principalType: "USER", principalId: created.bob, resourceId: resources.alpha.resourceId, permissionSet: "VIEWER" });
  assert.equal(g.ok, true);
  const r = svc.authorize({ context: ctx("bob", "resource-library"), action: domain.ACTION.READ, resource: resources.alpha.resourceId });
  assert.equal(r.decision, "ALLOW");
  assert.ok(r.allowSources.includes("USER_GRANT"));
});

test("DEPARTMENT：非本部门成员即使有 collection grant 概念也不能访问 → DENY", () => {
  const r = svc.authorize({ context: ctx("bob", "resource-library"), action: domain.ACTION.READ, resource: resources.designHero.resourceId });
  assert.equal(r.decision, "DENY");
});

test("DEPARTMENT：本部门成员 + Department grant → ALLOW", () => {
  const r = svc.authorize({ context: ctx("erin", "resource-library"), action: domain.ACTION.READ, resource: resources.designHero.resourceId });
  assert.equal(r.decision, "ALLOW");
  assert.ok(r.allowSources.includes("DEPARTMENT_GRANT"));
});

test("ORGANIZATION：同组织成员获得 ORG_POLICY 基线（read ALLOW / edit DENY）", () => {
  const read = svc.authorize({ context: ctx("alice", "resource-library"), action: domain.ACTION.READ, resource: resources.orgDoc.resourceId });
  const edit = svc.authorize({ context: ctx("alice", "resource-library"), action: domain.ACTION.EDIT, resource: resources.orgDoc.resourceId });
  assert.equal(read.decision, "ALLOW");
  assert.ok(read.allowSources.includes("ORG_POLICY"));
  assert.equal(edit.decision, "DENY");
});

test("cross organization → DENY ORGANIZATION_DENIED", () => {
  const r = svc.authorize({ context: ctx("frank", "resource-library"), action: domain.ACTION.READ, resource: resources.orgDoc.resourceId });
  assert.equal(r.decision, "DENY");
  assert.equal(r.reasonCode, "ORGANIZATION_DENIED");
});

test("scope 只信 Session + Registry，不信 Renderer 传入的 organizationId", () => {
  const spoofed = svc.authorize({
    context: { sessionRef: ctx("frank", "resource-library").sessionRef, appId: "resource-library", organizationId: f.orgId, userId: f.created.alice },
    action: domain.ACTION.READ,
    resource: resources.orgDoc.resourceId,
  });
  assert.equal(spoofed.decision, "DENY");
});
