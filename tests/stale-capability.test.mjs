/**
 * D3-02 · stale-capability.test
 * UI 的 canX 只是投影；真实 command 必须重新 authorize（§46 §61 §71）。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createFixture } from "./authorization-fixtures.mjs";

const f = await createFixture();
after(() => f.close());
const { svc, ctx, resources, created, domain } = f;

test("User capability：canEdit=true 之后 revoke，直接调用 edit → DENY", () => {
  const g = svc.grantResourcePermission({ context: f.adminCtx, principalType: "USER", principalId: created.erin, resourceId: resources.alpha.resourceId, permissionSet: "EDITOR" });
  assert.equal(g.ok, true);
  const caps = svc.getCapabilities({ context: ctx("erin", "resource-library"), resource: resources.alpha.resourceId });
  assert.equal(caps.capabilities.canEdit, true);
  const rev = svc.revokeResourcePermission({ context: f.adminCtx, grantId: g.grant.id });
  assert.equal(rev.ok, true);
  const edit = svc.authorize({ context: ctx("erin", "resource-library"), action: domain.ACTION.EDIT, resource: resources.alpha.resourceId });
  assert.equal(edit.decision, "DENY");
  const capsAfter = svc.getCapabilities({ context: ctx("erin", "resource-library"), resource: resources.alpha.resourceId });
  assert.equal(capsAfter.ok, false);
});

test("App capability：canRead=true 之后 revoke app grant，read → DENY", () => {
  const g = svc.grantAppResourcePermission({ context: f.adminCtx, appId: "image-generator", resourceId: resources.alpha.resourceId, actions: ["resource.read", "resource.view", "resource.preview"] });
  assert.equal(g.ok, true);
  const caps = svc.getCapabilities({ context: ctx("alice", "image-generator"), resource: resources.alpha.resourceId });
  assert.equal(caps.capabilities.canRead, true);
  svc.revokeAppResourcePermission({ context: f.adminCtx, grantId: g.grant.id });
  const read = svc.authorize({ context: ctx("alice", "image-generator"), action: domain.ACTION.READ, resource: resources.alpha.resourceId });
  assert.equal(read.decision, "DENY");
});

test("capability 里 canUseByAgent 仍是投影：没有 useByAgent 时 agent 调用被拒", () => {
  const caps = svc.getCapabilities({ context: ctx("erin", "ai"), resource: resources.designHero.resourceId });
  assert.equal(caps.capabilities.canUseByAgent, false);
  const agentRead = svc.authorize({ context: ctx("erin", "ai", { agentSessionId: "ags_stale" }), action: domain.ACTION.READ, resource: resources.designHero.resourceId });
  assert.equal(agentRead.decision, "DENY");
});
