/** D3-04C · resource-search-lifecycle.test —— 版本失效 / Trash / Restore / Metadata / Permanent Delete。 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createResourceFixture } from "./resource-fixtures.mjs";

const f = await createResourceFixture();
after(() => f.close());
const alice = f.ctx("alice");

test("内容更新：red shoes -> black shoes，旧正文不再命中", async () => {
  const r = await f.resourceService.createResource({ context: alice, resourceType: "text", name: "Color", content: "red shoes" });
  assert.equal((await f.searchService.search({ context: alice, query: "red", limit: 5 })).total, 1);
  await f.resourceService.replaceText({ context: alice, resourceRef: r.resource.resourceId, text: "black shoes", expectedVersion: 1 });
  assert.equal((await f.searchService.search({ context: alice, query: "red", limit: 5 })).total, 0);
  assert.equal((await f.searchService.search({ context: alice, query: "black", limit: 5 })).total, 1);
});

test("restoreVersion：v1 内容重新可搜（基于最新 Resource Version）", async () => {
  const r = await f.resourceService.createResource({ context: alice, resourceType: "text", name: "Restore", content: "rusty token" });
  await f.resourceService.replaceText({ context: alice, resourceRef: r.resource.resourceId, text: "shiny token", expectedVersion: 1 });
  assert.equal((await f.searchService.search({ context: alice, query: "rusty", limit: 5 })).total, 0);
  f.resourceService.restoreVersion({ context: alice, resourceRef: r.resource.resourceId, version: 1 });
  assert.equal((await f.searchService.search({ context: alice, query: "rusty", limit: 5 })).total, 1);
});

test("metadata 修改（rename/description/tag/collection）不 bump version 但刷新索引", async () => {
  const col = f.resourceService.createCollection({ context: alice, name: "MetaCol" });
  const r = await f.resourceService.createResource({ context: alice, resourceType: "text", name: "MetaOld", content: "body" });
  f.advance(1000);
  f.resourceService.updateMetadata({ context: alice, resourceRef: r.resource.resourceId, name: "MetaNew", description: "metadesc-token" });
  assert.equal((await f.searchService.search({ context: alice, query: "MetaNew", limit: 5 })).total, 1);
  assert.equal((await f.searchService.search({ context: alice, query: "metadesc-token", limit: 5 })).total, 1);
  f.advance(1000);
  f.resourceService.assignTag({ context: alice, resourceRef: r.resource.resourceId, name: "metatag" });
  assert.equal((await f.searchService.search({ context: alice, query: "metatag", limit: 5 })).total, 1);
  f.advance(1000);
  f.resourceService.setCollection({ context: alice, resourceRef: r.resource.resourceId, collectionId: col.collection.collectionId });
  assert.equal((await f.searchService.search({ context: alice, query: "MetaCol", limit: 5 })).total, 1);
  assert.equal(f.resourceService.get({ context: alice, resourceRef: r.resource.resourceId }).resource.version, 1);
});

test("Trash -> search 0；Restore -> 恢复；Permanent Delete -> 索引清理", async () => {
  const r = await f.resourceService.createResource({ context: alice, resourceType: "text", name: "Trashy", content: "trashy-token" });
  assert.equal((await f.searchService.search({ context: alice, query: "trashy-token", limit: 5 })).total, 1);
  f.resourceService.delete({ context: alice, resourceRef: r.resource.resourceId });
  assert.equal((await f.searchService.search({ context: alice, query: "trashy-token", limit: 5 })).total, 0);
  f.resourceService.restore({ context: alice, resourceRef: r.resource.resourceId });
  assert.equal((await f.searchService.search({ context: alice, query: "trashy-token", limit: 5 })).total, 1);
  f.resourceService.permanentDelete({ context: alice, resourceRef: r.resource.resourceId });
  await f.searchService.search({ context: alice, query: "trashy-token", limit: 5 }); // reconcile purges
  assert.equal(f.searchStore.documentById(r.resource.resourceId), null);
});

test("indexStatus 能标记 STALE / 版本不一致", async () => {
  const r = await f.resourceService.createResource({ context: alice, resourceType: "text", name: "StaleCheck", content: "stale v1" });
  await f.searchService.indexResource(r.resource.resourceId);
  const before = f.searchService.indexStatus({ context: alice, resourceRef: r.resource.resourceId });
  assert.equal(before.stale, false);
  await f.resourceService.replaceText({ context: alice, resourceRef: r.resource.resourceId, text: "stale v2", expectedVersion: 1 });
  const afterEdit = f.searchService.indexStatus({ context: alice, resourceRef: r.resource.resourceId });
  assert.equal(afterEdit.stale, true);
});
