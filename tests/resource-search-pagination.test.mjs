/** D3-04C · resource-search-pagination.test —— authorized pagination（total 只统计 authorized）。 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createResourceFixture } from "./resource-fixtures.mjs";

const f = await createResourceFixture();
after(() => f.close());
const alice = f.ctx("alice");
const dana = f.ctx("dana");

test("authorized pagination：limit / offset / total / hasMore 稳定", async () => {
  for (let i = 0; i < 25; i += 1) {
    await f.resourceService.createResource({ context: alice, resourceType: "text", name: "Page " + String(i).padStart(2, "0"), content: "pagetoken common" });
  }
  const p0 = await f.searchService.search({ context: alice, query: "pagetoken", limit: 10, offset: 0 });
  const p1 = await f.searchService.search({ context: alice, query: "pagetoken", limit: 10, offset: 10 });
  const p2 = await f.searchService.search({ context: alice, query: "pagetoken", limit: 10, offset: 20 });
  assert.equal(p0.total, 25);
  assert.equal(p0.items.length, 10);
  assert.equal(p0.hasMore, true);
  assert.equal(p1.items.length, 10);
  assert.equal(p2.items.length, 5);
  assert.equal(p2.hasMore, false);
  const ids = new Set([...p0.items, ...p1.items, ...p2.items].map((i) => i.resourceId));
  assert.equal(ids.size, 25, "分页不应重复或遗漏");
});

test("ACL-aware pagination：无权资源不计入 total，也不占页", async () => {
  const created = [];
  for (let i = 0; i < 20; i += 1) {
    const r = await f.resourceService.createResource({ context: alice, resourceType: "text", name: "ACL " + i, content: "acltoken shared" });
    created.push(r.resource.resourceId);
  }
  const allowed = new Set();
  for (let i = 0; i < 20; i += 2) {
    f.authService.grantResourcePermission({ context: f.adminCtx(), principalType: "USER", principalId: f.users.dana, resourceId: created[i], permissionSet: "VIEWER" });
    allowed.add(created[i]);
  }
  const page = await f.searchService.search({ context: dana, query: "acltoken", limit: 5, offset: 0 });
  assert.equal(page.ok, true);
  assert.equal(page.total, 10, "total 只能统计 authorized");
  assert.ok(page.items.every((i) => allowed.has(i.resourceId)));
  assert.equal(page.items.some((i) => !allowed.has(i.resourceId)), false);
  const page2 = await f.searchService.search({ context: dana, query: "acltoken", limit: 5, offset: 5 });
  assert.ok(page2.items.every((i) => allowed.has(i.resourceId)));
});
