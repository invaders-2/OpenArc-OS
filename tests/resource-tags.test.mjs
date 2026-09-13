/** D3-04B · resource-tags.test —— Tag CRUD / 规范化 / 不影响内容 version / 系统 Tag 保护。 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createResourceFixture } from "./resource-fixtures.mjs";
import { resourceDomain } from "./resource-fixtures.mjs";

const f = await createResourceFixture();
after(() => f.close());
const alice = f.ctx("alice");
const dana = f.ctx("dana");

test("Tag 规范化：显示名保留，比较用 normalized（Shoes == shoes）", () => {
  assert.deepEqual(resourceDomain.normalizeTagName("  Shoes  "), { ok: true, name: "Shoes", normalizedName: "shoes" });
  assert.equal(resourceDomain.normalizeTagName("   ").ok, false);
  assert.equal(resourceDomain.normalizeTagName("a".repeat(100)).ok, false);
});

test("assign / remove Tag；重复大小写不同视为同一个 Tag", async () => {
  const r = await f.resourceService.createResource({ context: alice, resourceType: "text", name: "Tagged", content: "x" });
  await f.resourceService.assignTag({ context: alice, resourceRef: r.resource.resourceId, name: "Shoes" });
  await f.resourceService.assignTag({ context: alice, resourceRef: r.resource.resourceId, name: "shoes" });
  await f.resourceService.assignTag({ context: alice, resourceRef: r.resource.resourceId, name: "work" });
  const tags = f.resourceService.listResourceTags({ context: alice, resourceRef: r.resource.resourceId });
  assert.equal(tags.items.length, 2);
  const orgTags = f.resourceService.listTags({ context: alice });
  assert.equal(orgTags.items.filter((t) => t.normalizedName === "shoes").length, 1);
});

test("删除 Tag 不改变 Resource 内容 / version", async () => {
  const r = await f.resourceService.createResource({ context: alice, resourceType: "text", name: "Keep", content: "original" });
  const assigned = f.resourceService.assignTag({ context: alice, resourceRef: r.resource.resourceId, name: "temp" });
  assert.equal(assigned.ok, true);
  const tagId = assigned.tags.find((t) => t.name === "temp").id;
  f.resourceService.deleteTag({ context: alice, tagId });
  const got = f.resourceService.get({ context: alice, resourceRef: r.resource.resourceId });
  assert.equal(got.resource.version, 1);
  assert.equal((await f.resourceService.readText({ context: alice, resourceRef: r.resource.resourceId })).text, "original");
});

test("rename User Tag；系统 Tag 普通用户不能改", () => {
  const r = f.resourceService.createTag({ context: alice, name: "Old" });
  const renamed = f.resourceService.renameTag({ context: alice, tagId: r.tag.id, name: "New" });
  assert.equal(renamed.ok, true);
  assert.equal(renamed.tag.name, "New");

  const sys = f.resourceStore.transactSync(() => f.resourceStore.insertTag({ organizationId: f.orgId, name: "SystemTag", normalizedName: "systemtag", source: "system", createdBy: null }));
  const denied = f.resourceService.renameTag({ context: dana, tagId: sys.id, name: "Hacked" });
  assert.equal(denied.ok, false);
});

test("query 按 Tag 过滤", async () => {
  const r = await f.resourceService.createResource({ context: alice, resourceType: "prompt", name: "Prompt Tagged", content: "p" });
  await f.resourceService.assignTag({ context: alice, resourceRef: r.resource.resourceId, name: "filterme" });
  const orgTags = f.resourceService.listTags({ context: alice });
  const tag = orgTags.items.find((t) => t.normalizedName === "filterme");
  const q = f.resourceService.queryResources({ context: alice, filter: { tagId: tag.tagId } });
  assert.equal(q.total, 1);
  assert.equal(q.items[0].resourceId, r.resource.resourceId);
});
