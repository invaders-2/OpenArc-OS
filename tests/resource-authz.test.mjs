/**
 * D3-04A · resource-authz.test —— Create / Read 授权，User ∩ App，撤销，Agent 边界。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createResourceFixture } from "./resource-fixtures.mjs";

const f = await createResourceFixture();
after(() => f.close());
const alice = f.ctx("alice");
const dana = f.ctx("dana");
const bob = f.ctx("bob");

test("User ALLOW + App ALLOW -> import/read ALLOW", async () => {
  const src = f.writeSource("authz.txt", "authz content");
  const imp = await f.resourceService.importManaged({ context: alice, sourcePath: src, name: "Authz" });
  assert.equal(imp.ok, true);
  const read = await f.resourceService.readText({ context: alice, resourceRef: imp.resource.resourceRef });
  assert.equal(read.ok, true);
});

test("User ALLOW + App DENY -> DENY（无 grant App 不能导入）", async () => {
  f.authService.registerApp({ context: f.adminCtx(), appId: "no-grant-app", name: "No Grant" });
  const src = f.writeSource("appdeny.txt", "app deny");
  const imp = await f.resourceService.importManaged({ context: { ...alice, appId: "no-grant-app" }, sourcePath: src, name: "App Deny" });
  assert.equal(imp.ok, false);
  assert.equal(imp.error, "APP_ACTION_NOT_GRANTED");
});

test("User DENY + App ALLOW -> DENY（read）", async () => {
  const src = f.writeSource("userdeny.txt", "user deny");
  const imp = await f.resourceService.importManaged({ context: alice, sourcePath: src, name: "Alice Private" });
  const ref = imp.resource.resourceRef;
  const read = await f.resourceService.readText({ context: dana, resourceRef: ref });
  assert.equal(read.ok, false);
  // app 侧本身允许（image-generator 有 read baseline），但用户侧不成立
  const authz = f.authService.authorize({ context: { ...dana, appId: "image-generator" }, action: "resource.read", resource: ref });
  assert.equal(authz.decision, "DENY");
});

test("Department create 无 create permission -> DENY", async () => {
  const src = f.writeSource("deptcreate.txt", "dept create");
  const imp = await f.resourceService.importManaged({ context: alice, sourcePath: src, name: "Dept Create", scope: "DEPARTMENT", departmentId: f.departmentId });
  assert.equal(imp.ok, false);
});

test("cross organization -> DENY（读其他组织的 Resource）", async () => {
  const src = f.writeSource("cross.txt", "cross org");
  const imp = await f.resourceService.importManaged({ context: alice, sourcePath: src, name: "Cross Org A" });
  assert.equal(imp.ok, true);
  const denied = await f.resourceService.readText({ context: bob, resourceRef: imp.resource.resourceRef });
  assert.equal(denied.ok, false);
  const authz = f.authService.authorize({ context: bob, action: "resource.read", resource: imp.resource.resourceRef });
  assert.equal(authz.decision, "DENY");
  assert.equal(authz.reasonCode, "ORGANIZATION_DENIED");
});

test("revoked grant -> 下一 read DENY", async () => {
  const src = f.writeSource("grant.txt", "grant content");
  const imp = await f.resourceService.importManaged({ context: alice, sourcePath: src, name: "Grant" });
  const rid = imp.resource.resourceId;
  const g = f.authService.grantResourcePermission({ context: f.adminCtx(), principalType: "USER", principalId: f.users.dana, resourceId: rid, permissionSet: "VIEWER" });
  assert.equal(g.ok, true);
  const allow = f.resourceService.read({ context: dana, resourceRef: imp.resource.resourceRef });
  assert.equal(allow.ok, true);
  f.authService.revokeResourcePermission({ context: f.adminCtx(), grantId: g.grant.id });
  const deny = f.resourceService.read({ context: dana, resourceRef: imp.resource.resourceRef });
  assert.equal(deny.ok, false);
});

test("Agent：无 useByAgent -> DENY；grant 后 ALLOW", async () => {
  const src = f.writeSource("agent.txt", "agent content");
  const imp = await f.resourceService.importManaged({ context: alice, sourcePath: src, name: "Agent" });
  const ref = imp.resource.resourceRef;
  const agentCtx = { ...alice, appId: "ai", agentSessionId: "ags_d3_04a" };
  const agentAuthz = f.authService.authorize({ context: agentCtx, action: "resource.read", resource: ref });
  assert.equal(agentAuthz.decision, "ALLOW", "owner policy 含 useByAgent，ai app baseline 含 useByAgent");

  // dana 有 VIEWER（无 useByAgent）-> Agent DENY
  const g = f.authService.grantResourcePermission({ context: f.adminCtx(), principalType: "USER", principalId: f.users.dana, resourceId: imp.resource.resourceId, permissionSet: "VIEWER" });
  const danaAgent = f.authService.authorize({ context: { ...dana, appId: "ai", agentSessionId: "ags_d3_04a" }, action: "resource.read", resource: ref });
  assert.equal(danaAgent.decision, "DENY");
  assert.equal(danaAgent.reasonCode, "AGENT_USE_NOT_AUTHORIZED");

  const g2 = f.authService.grantResourcePermission({ context: f.adminCtx(), principalType: "USER", principalId: f.users.dana, resourceId: imp.resource.resourceId, actions: ["resource.useByAgent"] });
  assert.equal(g2.ok, true);
  const danaAgent2 = f.authService.authorize({ context: { ...dana, appId: "ai", agentSessionId: "ags_d3_04a" }, action: "resource.read", resource: ref });
  assert.equal(danaAgent2.decision, "ALLOW");
});
