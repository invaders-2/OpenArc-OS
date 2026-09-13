/** D3-04B · resource-favorites.test —— per-user Favorite。 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createResourceFixture } from "./resource-fixtures.mjs";

const f = await createResourceFixture();
after(() => f.close());
const alice = f.ctx("alice");
const dana = f.ctx("dana");

test("Favorite 是 per-user，不是 Resource 全局状态", async () => {
  const r = await f.resourceService.createResource({ context: alice, resourceType: "text", name: "Fav", content: "x" });
  const set = f.resourceService.setFavorite({ context: alice, resourceRef: r.resource.resourceId, favorite: true });
  assert.equal(set.ok, true);
  assert.equal(set.favorite, true);
  assert.equal(f.resourceService.listFavorites({ context: alice }).count, 1);
  assert.equal(f.resourceService.listFavorites({ context: dana }).count, 0);
});

test("Favorite 不产生内容 version；query category=favorites 生效", async () => {
  const r = await f.resourceService.createResource({ context: alice, resourceType: "text", name: "Fav2", content: "x" });
  f.resourceService.setFavorite({ context: alice, resourceRef: r.resource.resourceId, favorite: true });
  const got = f.resourceService.get({ context: alice, resourceRef: r.resource.resourceId });
  assert.equal(got.resource.version, 1);
  const q = f.resourceService.queryResources({ context: alice, category: "favorites" });
  assert.ok(q.items.some((i) => i.resourceId === r.resource.resourceId));
});

test("取消收藏；Trash 后不出现在 Favorites，Restore 后回来", async () => {
  const r = await f.resourceService.createResource({ context: alice, resourceType: "text", name: "Fav3", content: "x" });
  f.resourceService.setFavorite({ context: alice, resourceRef: r.resource.resourceId, favorite: true });
  f.resourceService.delete({ context: alice, resourceRef: r.resource.resourceId });
  assert.equal(f.resourceService.listFavorites({ context: alice }).items.some((i) => i.resourceId === r.resource.resourceId), false);
  f.resourceService.restore({ context: alice, resourceRef: r.resource.resourceId });
  assert.equal(f.resourceService.listFavorites({ context: alice }).items.some((i) => i.resourceId === r.resource.resourceId), true);
  const unset = f.resourceService.setFavorite({ context: alice, resourceRef: r.resource.resourceId, favorite: false });
  assert.equal(unset.favorite, false);
  assert.equal(f.resourceService.listFavorites({ context: alice }).items.some((i) => i.resourceId === r.resource.resourceId), false);
});
