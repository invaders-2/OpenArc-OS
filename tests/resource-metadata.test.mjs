/** D3-04B · resource-metadata.test —— Metadata vs Content version 边界。 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createResourceFixture } from "./resource-fixtures.mjs";

const f = await createResourceFixture();
after(() => f.close());
const ctx = f.ctx("alice");

test("Rename/Description/Tag/Favorite/Collection 都不产生内容 version", async () => {
  const r = await f.resourceService.createResource({ context: ctx, resourceType: "text", name: "Stable", content: "v1 body" });
  const ref = r.resource.resourceId;
  const col = f.resourceService.createCollection({ context: ctx, name: "C" });
  f.resourceService.updateMetadata({ context: ctx, resourceRef: ref, name: "Stable2", description: "desc" });
  f.resourceService.assignTag({ context: ctx, resourceRef: ref, name: "t1" });
  f.resourceService.setFavorite({ context: ctx, resourceRef: ref, favorite: true });
  f.resourceService.setCollection({ context: ctx, resourceRef: ref, collectionId: col.collection.collectionId });
  const got = f.resourceService.get({ context: ctx, resourceRef: ref });
  assert.equal(got.resource.version, 1);
  assert.equal(f.resourceStore.versionsOf(ref).length, 1);
  const read = await f.resourceService.readText({ context: ctx, resourceRef: ref });
  assert.equal(read.text, "v1 body");
});

test("replaceText 修改内容 -> version +1，ResourceRef 不变", async () => {
  const r = await f.resourceService.createResource({ context: ctx, resourceType: "text", name: "Edit", content: "one" });
  const res = await f.resourceService.replaceText({ context: ctx, resourceRef: r.resource.resourceId, text: "two", expectedVersion: 1 });
  assert.equal(res.ok, true);
  assert.equal(res.resource.version, 2);
  assert.equal(res.resource.resourceRef, r.resource.resourceRef);
  const read = await f.resourceService.readText({ context: ctx, resourceRef: r.resource.resourceId });
  assert.equal(read.text, "two");
});

test("非法 metadata 输入被拒（collection 不属于组织 / 非法 memory subtype）", async () => {
  const r = await f.resourceService.createResource({ context: ctx, resourceType: "memory", name: "M", content: "x", memorySubtype: "project-memory" });
  const badSub = f.resourceService.updateMetadata({ context: ctx, resourceRef: r.resource.resourceId, memorySubtype: "not-a-subtype" });
  assert.equal(badSub.ok, false);
  const badCol = f.resourceService.updateMetadata({ context: ctx, resourceRef: r.resource.resourceId, collectionId: "col_does_not_exist" });
  assert.equal(badCol.ok, false);
});

test("resource/updateMetadata 不允许 Renderer 改 owner/organization/checksum（接口不接收）", async () => {
  const r = await f.resourceService.createResource({ context: ctx, resourceType: "text", name: "Guard", content: "x" });
  // 传入不存在字段不生效
  f.resourceService.updateMetadata({ context: ctx, resourceRef: r.resource.resourceId, ownerUserId: "usr_hacker", organizationId: "team_hacker", checksum: "deadbeef" });
  const got = f.resourceService.get({ context: ctx, resourceRef: r.resource.resourceId });
  assert.equal(got.resource.ownerUserId, f.users.alice);
  assert.equal(got.resource.checksum.startsWith("deadbeef"), false);
});
