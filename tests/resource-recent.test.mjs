/** D3-04B · resource-recent.test —— per-user Recent，只有真实打开才更新。 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createResourceFixture } from "./resource-fixtures.mjs";

const f = await createResourceFixture();
after(() => f.close());
const alice = f.ctx("alice");
const dana = f.ctx("dana");

test("Recent 是 per-user；背景 list 不会写入 Recent", async () => {
  const r = await f.resourceService.createResource({ context: alice, resourceType: "text", name: "Recent A", content: "x" });
  f.resourceService.queryResources({ context: alice, category: "all" });
  f.resourceService.list({ context: alice });
  assert.equal(f.resourceService.listRecent({ context: alice }).count, 0, "list/query 不算用户打开");
  const touched = f.resourceService.touchRecent({ context: alice, resourceRef: r.resource.resourceId });
  assert.equal(touched.ok, true);
  assert.equal(f.resourceService.listRecent({ context: alice }).count, 1);
  assert.equal(f.resourceService.listRecent({ context: dana }).count, 0);
});

test("query category=recent 按 last_opened_at 排序", async () => {
  const a = await f.resourceService.createResource({ context: alice, resourceType: "text", name: "R1", content: "1" });
  const b = await f.resourceService.createResource({ context: alice, resourceType: "text", name: "R2", content: "2" });
  f.resourceService.touchRecent({ context: alice, resourceRef: a.resource.resourceId });
  f.advance(1000);
  f.resourceService.touchRecent({ context: alice, resourceRef: b.resource.resourceId });
  const q = f.resourceService.queryResources({ context: alice, category: "recent" });
  assert.ok(q.total >= 2);
  assert.equal(q.items[0].resourceId, b.resource.resourceId, "最近打开的排最前");
});

test("Trash 后不出现在 Recent", async () => {
  const r = await f.resourceService.createResource({ context: alice, resourceType: "text", name: "Recent Trash", content: "x" });
  f.resourceService.touchRecent({ context: alice, resourceRef: r.resource.resourceId });
  f.resourceService.delete({ context: alice, resourceRef: r.resource.resourceId });
  assert.equal(f.resourceService.listRecent({ context: alice }).items.some((i) => i.resourceId === r.resource.resourceId), false);
});
