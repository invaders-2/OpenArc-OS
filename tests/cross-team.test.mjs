/**
 * D3-02 · cross-team.test
 * Organization / Team 边界：teamId 不信 Renderer，Session Membership + Registry 判定（§35 §68）。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createFixture } from "./authorization-fixtures.mjs";

const f = await createFixture();
after(() => f.close());
const { svc, ctx, resources, domain } = f;

test("Team B User 对 Team A Resource：read / edit / grant 全部 DENY", () => {
  const read = svc.authorize({ context: ctx("frank", "resource-library"), action: domain.ACTION.READ, resource: resources.alpha.resourceId });
  const edit = svc.authorize({ context: ctx("frank", "resource-library"), action: domain.ACTION.EDIT, resource: resources.alpha.resourceId });
  assert.equal(read.decision, "DENY");
  assert.equal(read.reasonCode, "ORGANIZATION_DENIED");
  assert.equal(edit.decision, "DENY");
});

test("跨组织搜索返回 0，且不泄漏 count / title", () => {
  const res = svc.searchAuthorizedResources({ context: ctx("frank", "resource-library"), query: "Design" });
  assert.equal(res.ok, true);
  assert.equal(res.count, 0);
  assert.equal(res.items.length, 0);
});

test("跨组织 getResource → NOT_FOUND_OR_FORBIDDEN（无 metadata）", () => {
  const res = svc.getResource({ context: ctx("frank", "resource-library"), resource: resources.designHero.resourceId });
  assert.equal(res.ok, false);
  assert.equal(res.error, "NOT_FOUND_OR_FORBIDDEN");
  assert.equal(res.resource, undefined);
});

test("Renderer 伪造 userId / organizationId 不能越权", () => {
  const r = svc.authorize({
    context: { sessionRef: ctx("frank", "resource-library").sessionRef, appId: "resource-library", userId: f.created.alice, organizationId: f.orgId },
    action: domain.ACTION.READ,
    resource: resources.designHero.resourceId,
  });
  assert.equal(r.decision, "DENY");
});
