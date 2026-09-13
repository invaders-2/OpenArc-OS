/**
 * D3-02 · query-filter.test
 * 服务端授权过滤，禁止 SELECT all → Renderer/Agent → 再过滤（§36 §37 §73）。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createFixture } from "./authorization-fixtures.mjs";

const f = await createFixture();
after(() => f.close());
const { svc, ctx, resources, created, collections, domain } = f;

test("listAuthorizedResources 只返回当前用户可访问的资源", () => {
  const res = svc.listAuthorizedResources({ context: ctx("alice", "resource-library") });
  const ids = res.items.map((i) => i.resourceId);
  assert.ok(ids.includes(resources.alpha.resourceId));
  assert.ok(ids.includes(resources.designHero.resourceId));
  assert.ok(ids.includes(resources.orgDoc.resourceId));
  assert.ok(!ids.includes(resources.omega.resourceId));
  assert.ok(!ids.includes(resources.memorySecret.resourceId));
  assert.ok(!ids.includes(resources.deptBImage.resourceId));
});

test("searchAuthorizedResources：无权资源不进入结果", () => {
  const design = svc.searchAuthorizedResources({ context: ctx("alice", "resource-library"), query: "Design" });
  assert.equal(design.count, 1);
  assert.equal(design.items[0].resourceId, resources.designHero.resourceId);
  const secret = svc.searchAuthorizedResources({ context: ctx("alice", "resource-library"), query: "Secret" });
  assert.equal(secret.count, 0);
});

test("App Search Intersection：User Accessible ∩ App Accessible", () => {
  const photoshopDesign = svc.searchAuthorizedResources({ context: ctx("alice", "photoshop"), query: "Design" });
  assert.equal(photoshopDesign.count, 1);
  // alice 能看到 Org Handbook（ORG_POLICY），但 photoshop 没有相应 app grant → 交集为空
  const photoshopOrg = svc.searchAuthorizedResources({ context: ctx("alice", "photoshop"), query: "Org" });
  assert.equal(photoshopOrg.count, 0);
});

test("Agent Search：没有 useByAgent 时返回 0 结果", () => {
  const before = svc.searchAuthorizedResources({ context: ctx("erin", "ai", { agentSessionId: "ags_search" }), query: "Design" });
  assert.equal(before.count, 0);
  svc.grantResourcePermission({ context: f.adminCtx, principalType: "USER", principalId: created.erin, collectionId: collections.design.id, actions: ["resource.useByAgent"] });
  const afterG = svc.searchAuthorizedResources({ context: ctx("erin", "ai", { agentSessionId: "ags_search" }), query: "Design" });
  assert.equal(afterG.count, 1);
});

test("filter 参数在授权边界内生效（resourceType）", () => {
  const images = svc.listAuthorizedResources({ context: ctx("alice", "resource-library"), filter: { resourceType: "image" } });
  assert.ok(images.items.every((i) => i.resourceType === "image"));
  assert.ok(images.items.some((i) => i.resourceId === resources.designHero.resourceId));
});
