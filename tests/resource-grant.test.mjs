/**
 * D3-02 · resource-grant.test
 * Grant / Revoke / 唯一约束 / 幂等 / 审计旧新权限（§21 §45 §50 §51 §57）。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createFixture } from "./authorization-fixtures.mjs";

const f = await createFixture();
after(() => f.close());
const { svc, ctx, resources, created, domain } = f;

test("grant → 下一请求 ALLOW；revoke → 下一请求 DENY", () => {
  const g = svc.grantResourcePermission({ context: f.adminCtx, principalType: "USER", principalId: created.erin, resourceId: resources.alpha.resourceId, permissionSet: "VIEWER" });
  assert.equal(g.ok, true);
  const allow = svc.authorize({ context: ctx("erin", "resource-library"), action: domain.ACTION.READ, resource: resources.alpha.resourceId });
  assert.equal(allow.decision, "ALLOW");
  const rev = svc.revokeResourcePermission({ context: f.adminCtx, grantId: g.grant.id });
  assert.equal(rev.ok, true);
  const deny = svc.authorize({ context: ctx("erin", "resource-library"), action: domain.ACTION.READ, resource: resources.alpha.resourceId });
  assert.equal(deny.decision, "DENY");
});

test("重复 revoke → 幂等 NO_CHANGE，不抛数据库异常", () => {
  const g = svc.grantResourcePermission({ context: f.adminCtx, principalType: "USER", principalId: created.erin, resourceId: resources.omega.resourceId, permissionSet: "VIEWER" });
  const first = svc.revokeResourcePermission({ context: f.adminCtx, grantId: g.grant.id });
  const second = svc.revokeResourcePermission({ context: f.adminCtx, grantId: g.grant.id });
  assert.equal(first.changed, true);
  assert.equal(second.ok, true);
  assert.equal(second.changed, false);
  assert.equal(second.reasonCode, "NO_CHANGE");
});

test("Grant 唯一性：同 principal/resource 重复 grant 只留一行，动作合并", () => {
  const key = { principalType: "USER", principalId: created.erin, resourceId: resources.designHero.resourceId };
  svc.grantResourcePermission({ context: f.adminCtx, ...key, actions: ["resource.read"] });
  svc.grantResourcePermission({ context: f.adminCtx, ...key, actions: ["resource.download"] });
  const rows = f.store
    .grantsForResource(resources.designHero.resourceId)
    .filter((r) => r.principal_type === "USER" && r.principal_id === created.erin);
  assert.equal(rows.length, 1);
  const actions = domain.grantActions(rows[0]);
  assert.ok(actions.includes("resource.read"));
  assert.ok(actions.includes("resource.download"));
});

test("Permission Set 只映射动作集合：VIEWER 不含 edit/delete/useByAgent", () => {
  const g = svc.grantResourcePermission({ context: f.adminCtx, principalType: "USER", principalId: created.erin, resourceId: resources.memorySecret.resourceId, permissionSet: "VIEWER" });
  const actions = domain.grantActions(g.grant);
  assert.ok(actions.includes("resource.read"));
  assert.ok(!actions.includes("resource.edit"));
  assert.ok(!actions.includes("resource.delete"));
  assert.ok(!actions.includes("resource.useByAgent"));
});

test("Grant / Revoke 审计记录 oldPermissions / newPermissions", () => {
  const g = svc.grantResourcePermission({ context: f.adminCtx, principalType: "USER", principalId: created.erin, resourceId: resources.alpha.resourceId, actions: ["resource.read"] });
  svc.revokeResourcePermission({ context: f.adminCtx, grantId: g.grant.id });
  const audit = f.store.authorizationAudit();
  const grantAudit = audit.filter((a) => a.action === "governance.grantResourcePermission" && a.new_permissions);
  const revokeAudit = audit.filter((a) => a.action === "governance.revokeResourcePermission" && a.old_permissions);
  assert.ok(grantAudit.length >= 1);
  assert.ok(revokeAudit.length >= 1);
});

test("非法动作 / 非法 principal → DENY INVALID_INPUT", () => {
  const badAction = svc.grantResourcePermission({ context: f.adminCtx, principalType: "USER", principalId: created.erin, resourceId: resources.alpha.resourceId, actions: ["resource.teleport"] });
  const badPrincipal = svc.grantResourcePermission({ context: f.adminCtx, principalType: "ROBOT", principalId: created.erin, resourceId: resources.alpha.resourceId, actions: ["resource.read"] });
  assert.equal(badAction.ok, false);
  assert.equal(badAction.error, "INVALID_INPUT");
  assert.equal(badPrincipal.ok, false);
  assert.equal(badPrincipal.error, "INVALID_INPUT");
});
