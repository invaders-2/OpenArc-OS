/** D3-04B · resource-collections.test —— Collection CRUD / 删除不级联 / 授权。 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createResourceFixture } from "./resource-fixtures.mjs";

const f = await createResourceFixture();
after(() => f.close());
const alice = f.ctx("alice");
const dana = f.ctx("dana");

test("Create / Rename / List Collection", () => {
  const col = f.resourceService.createCollection({ context: alice, name: "Ideas" });
  assert.equal(col.ok, true);
  const renamed = f.resourceService.updateCollection({ context: alice, collectionId: col.collection.collectionId, name: "Ideas v2", description: "d" });
  assert.equal(renamed.ok, true);
  assert.equal(renamed.collection.name, "Ideas v2");
  const list = f.resourceService.listCollections({ context: alice });
  assert.ok(list.items.some((c) => c.collectionId === col.collection.collectionId));
});

test("Move Resource into Collection；Collection 计数反映", async () => {
  const col = f.resourceService.createCollection({ context: alice, name: "Box" });
  await f.resourceService.createResource({ context: alice, resourceType: "text", name: "In Box", content: "x", collectionId: col.collection.collectionId });
  const list = f.resourceService.listCollections({ context: alice });
  const view = list.items.find((c) => c.collectionId === col.collection.collectionId);
  assert.equal(view.resourceCount, 1);
  const q = f.resourceService.queryResources({ context: alice, filter: { collectionId: col.collection.collectionId } });
  assert.equal(q.total, 1);
});

test("删除 Collection：Resource 不删除，转入 Unfiled", async () => {
  const col = f.resourceService.createCollection({ context: alice, name: "Temp" });
  const r1 = await f.resourceService.createResource({ context: alice, resourceType: "text", name: "Keep A", content: "a", collectionId: col.collection.collectionId });
  const r2 = await f.resourceService.createResource({ context: alice, resourceType: "text", name: "Keep B", content: "b", collectionId: col.collection.collectionId });
  const del = f.resourceService.deleteCollection({ context: alice, collectionId: col.collection.collectionId });
  assert.equal(del.ok, true);
  assert.equal(del.movedToUnfiled, 2);
  const list = f.resourceService.listCollections({ context: alice });
  assert.equal(list.items.some((c) => c.collectionId === col.collection.collectionId), false);
  for (const r of [r1, r2]) {
    const got = f.resourceService.get({ context: alice, resourceRef: r.resource.resourceId });
    assert.equal(got.ok, true, "Resource 必须仍然存在");
    assert.equal(got.resource.collectionId, null);
  }
  const unfiled = f.resourceService.queryResources({ context: alice, filter: { collectionId: "unfiled" } });
  assert.ok(unfiled.total >= 2);
});

test("Collection 授权：非 owner 不能改他人 Personal Collection", () => {
  const col = f.resourceService.createCollection({ context: alice, name: "Alice Only" });
  const hack = f.resourceService.updateCollection({ context: dana, collectionId: col.collection.collectionId, name: "Hacked" });
  assert.equal(hack.ok, false);
  const del = f.resourceService.deleteCollection({ context: dana, collectionId: col.collection.collectionId });
  assert.equal(del.ok, false);
});
