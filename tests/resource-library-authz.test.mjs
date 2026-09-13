/** D3-04B · resource-library-authz.test —— User ∩ App / capability breakdown / revoke。 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createResourceFixture } from "./resource-fixtures.mjs";

const f = await createResourceFixture();
after(() => f.close());
const alice = f.ctx("alice");
const dana = f.ctx("dana");

test("User ALLOW + App DENY -> create/inspector DENY（内置 App 也过 App Principal）", async () => {
  f.authService.registerApp({ context: f.adminCtx(), appId: "no-grant-app", name: "No Grant" });
  const created = await f.resourceService.createResource({ context: { ...alice, appId: "no-grant-app" }, resourceType: "text", name: "NoGrant", content: "x" });
  assert.equal(created.ok, false);
  assert.equal(created.error, "APP_ACTION_NOT_GRANTED");
});

test("禁用 resource-library App -> 下一 read DENY", async () => {
  const r = await f.resourceService.createResource({ context: alice, resourceType: "text", name: "AppDisabled", content: "x" });
  f.authService.grantResourcePermission({ context: f.adminCtx(), principalType: "USER", principalId: f.users.dana, resourceId: r.resource.resourceId, permissionSet: "VIEWER" });
  assert.equal((await f.resourceService.readText({ context: dana, resourceRef: r.resource.resourceId })).ok, true);
  f.authService.setAppStatus({ context: f.adminCtx(), appId: "resource-library", status: "disabled" });
  const denied = await f.resourceService.readText({ context: dana, resourceRef: r.resource.resourceId });
  assert.equal(denied.ok, false);
  f.authService.setAppStatus({ context: f.adminCtx(), appId: "resource-library", status: "enabled" });
});

test("撤销 grant -> inspector/read 下一请求 DENY", async () => {
  const r = await f.resourceService.createResource({ context: alice, resourceType: "text", name: "RevokeMe", content: "x" });
  const g = f.authService.grantResourcePermission({ context: f.adminCtx(), principalType: "USER", principalId: f.users.dana, resourceId: r.resource.resourceId, permissionSet: "VIEWER" });
  assert.equal(f.resourceService.getInspector({ context: dana, resourceRef: r.resource.resourceId }).ok, true);
  f.authService.revokeResourcePermission({ context: f.adminCtx(), grantId: g.grant.id });
  assert.equal(f.resourceService.getInspector({ context: dana, resourceRef: r.resource.resourceId }).ok, false);
  assert.equal((await f.resourceService.readText({ context: dana, resourceRef: r.resource.resourceId })).ok, false);
});

test("Viewer capability：canRead=true / canEdit=false；breakdown 分开 user 与 app", async () => {
  const r = await f.resourceService.createResource({ context: alice, resourceType: "text", name: "ViewerCaps", content: "x" });
  f.authService.grantResourcePermission({ context: f.adminCtx(), principalType: "USER", principalId: f.users.dana, resourceId: r.resource.resourceId, permissionSet: "VIEWER" });
  const insp = f.resourceService.getInspector({ context: dana, resourceRef: r.resource.resourceId });
  assert.equal(insp.ok, true);
  assert.equal(insp.capabilities.effective.canRead, true);
  assert.equal(insp.capabilities.effective.canEdit, false);
  assert.ok(insp.capabilities.userActions.includes("resource.read"));
  assert.ok(insp.capabilities.appActions.includes("resource.read"));
  assert.ok(insp.capabilities.effectiveActions.includes("resource.read"));
});

test("App 侧无 Memory 权限时，即使 User 有 read 也不能读 Memory", async () => {
  const mem = await f.resourceService.createResource({ context: alice, resourceType: "memory", name: "MemoryApp", content: "m" });
  f.authService.grantResourcePermission({ context: f.adminCtx(), principalType: "USER", principalId: f.users.dana, resourceId: mem.resource.resourceId, permissionSet: "VIEWER" });
  const viaImage = f.resourceService.getInspector({ context: { ...dana, appId: "image-generator" }, resourceRef: mem.resource.resourceId });
  assert.equal(viaImage.ok, false);
  const viaLibrary = f.resourceService.getInspector({ context: dana, resourceRef: mem.resource.resourceId });
  assert.equal(viaLibrary.ok, true);
});
