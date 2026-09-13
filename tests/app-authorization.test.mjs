/**
 * D3-02 · app-authorization.test
 * 铁律：User 权限 ≠ App 权限，两者必须同时成立（§23 §24 §47 §48 §71）。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createFixture } from "./authorization-fixtures.mjs";

const f = await createFixture();
after(() => f.close());
const { svc, ctx, resources, domain } = f;
let alphaAppGrantId = null;

test("User ALLOW + App DENY → DENY", () => {
  const r = svc.authorize({ context: ctx("alice", "image-generator"), action: domain.ACTION.READ, resource: resources.alpha.resourceId });
  assert.equal(r.decision, "DENY");
  assert.equal(r.reasonCode, "APP_ACTION_NOT_GRANTED");
});

test("User DENY + App ALLOW → DENY", () => {
  const r = svc.authorize({ context: ctx("erin", "image-generator"), action: domain.ACTION.READ, resource: resources.deptBImage.resourceId });
  assert.equal(r.decision, "DENY");
  assert.equal(r.reasonCode, "DEPARTMENT_DENIED");
});

test("User ALLOW + App ALLOW → ALLOW", () => {
  const g = svc.grantAppResourcePermission({ context: f.adminCtx, appId: "image-generator", resourceId: resources.alpha.resourceId, actions: ["resource.read", "resource.view", "resource.preview"] });
  assert.equal(g.ok, true);
  alphaAppGrantId = g.grant.id;
  const r = svc.authorize({ context: ctx("alice", "image-generator"), action: domain.ACTION.READ, resource: resources.alpha.resourceId });
  assert.equal(r.decision, "ALLOW");
});

test("App revoke → 下一请求立即 DENY", () => {
  const rev = svc.revokeAppResourcePermission({ context: f.adminCtx, grantId: alphaAppGrantId });
  assert.equal(rev.ok, true);
  const r = svc.authorize({ context: ctx("alice", "image-generator"), action: domain.ACTION.READ, resource: resources.alpha.resourceId });
  assert.equal(r.decision, "DENY");
});

test("App Image only → Memory read → DENY（§25）", () => {
  const r = svc.authorize({ context: ctx("bob", "image-generator"), action: domain.ACTION.READ, resource: resources.memorySecret.resourceId });
  assert.equal(r.decision, "DENY");
  assert.equal(r.reasonCode, "APP_ACTION_NOT_GRANTED");
});

test("全局 App grant 不覆盖 memory：普通第三方 App 默认 DENY memory", () => {
  svc.grantAppResourcePermission({ context: f.adminCtx, appId: "image-generator", actions: ["resource.read", "resource.view", "resource.preview"] });
  const r = svc.authorize({ context: ctx("bob", "image-generator"), action: domain.ACTION.READ, resource: resources.memorySecret.resourceId });
  assert.equal(r.decision, "DENY");
});

test("disabled App → 新 Resource Authorization DENY", () => {
  svc.setAppStatus({ context: f.adminCtx, appId: "image-generator", status: "disabled" });
  const r = svc.authorize({ context: ctx("alice", "image-generator"), action: domain.ACTION.READ, resource: resources.alpha.resourceId });
  assert.equal(r.decision, "DENY");
  assert.equal(r.reasonCode, "APP_DISABLED");
  svc.setAppStatus({ context: f.adminCtx, appId: "image-generator", status: "enabled" });
});

test("App 更新权限扩大（read → read+delete）必须重新批准", () => {
  const r = svc.evaluateAppPermissionUpgrade({ currentActions: ["resource.read"], requestedActions: ["resource.read", "resource.delete"] });
  assert.equal(r.requiresReapproval, true);
  assert.ok(r.added.includes("resource.delete"));
  const same = svc.evaluateAppPermissionUpgrade({ currentActions: ["resource.read"], requestedActions: ["resource.read"] });
  assert.equal(same.requiresReapproval, false);
});
