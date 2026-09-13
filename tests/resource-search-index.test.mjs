/** D3-04C · resource-search-index.test —— Index Document / matched fields / snippet / ranking。 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createResourceFixture } from "./resource-fixtures.mjs";

const f = await createResourceFixture();
after(() => f.close());
const alice = f.ctx("alice");

test("Index Document 含 name/description/tags/collection/content", async () => {
  const col = f.resourceService.createCollection({ context: alice, name: "Design Col" });
  const r = await f.resourceService.createResource({ context: alice, resourceType: "text", name: "Index Doc", description: "desc-token", content: "body-token", collectionId: col.collection.collectionId });
  f.resourceService.assignTag({ context: alice, resourceRef: r.resource.resourceId, name: "tag-token" });
  await f.searchService.indexResource(r.resource.resourceId);
  const doc = f.searchStore.documentById(r.resource.resourceId);
  assert.equal(doc.index_status, "READY");
  assert.ok(doc.name.includes("Index Doc"));
  assert.ok(doc.content_text.includes("body-token"));
  assert.ok(doc.tags_text.includes("tag-token"));
  assert.ok(doc.collection_name.includes("Design Col"));
  assert.equal(doc.resource_version, 1);
});

test("matchedFields 正确区分 name / content / tag / collection", async () => {
  const col = f.resourceService.createCollection({ context: alice, name: "collmatch" });
  const r = await f.resourceService.createResource({ context: alice, resourceType: "text", name: "namematch", description: "descmatch", content: "contentmatch", collectionId: col.collection.collectionId });
  f.resourceService.assignTag({ context: alice, resourceRef: r.resource.resourceId, name: "tagmatch" });
  for (const [q, field] of [["namematch", "name"], ["descmatch", "description"], ["contentmatch", "content"], ["tagmatch", "tag"], ["collmatch", "collection"]]) {
    const res = await f.searchService.search({ context: alice, query: q, limit: 10 });
    assert.ok(res.items.some((i) => i.matchedFields.includes(field)), q + " 应命中 " + field + "，实际 " + JSON.stringify(res.items.map((i) => i.matchedFields)));
  }
});

test("snippet 结构化（无 HTML），长度受限", async () => {
  const long = "prefix ".repeat(200) + "needletoken" + " suffix".repeat(200);
  const r = await f.resourceService.createResource({ context: alice, resourceType: "text", name: "Snippet", content: long });
  const res = await f.searchService.search({ context: alice, query: "needletoken", limit: 5 });
  assert.equal(res.total, 1);
  const item = res.items[0];
  assert.ok(item.snippet.matched);
  assert.ok(item.snippet.text.length <= 300);
  assert.equal(typeof item.snippet.spans[0].text, "string");
  assert.ok(!item.snippet.spans.some((s) => /<[a-z]/i.test(s.text)), "snippet 不得含 HTML 标签");
  assert.ok(item.snippet.spans.some((s) => s.match && s.text.includes("needletoken")));
});

test("ranking 确定性：同名查询可复现", async () => {
  await f.resourceService.createResource({ context: alice, resourceType: "text", name: "rankable", content: "rankable" });
  const a = await f.searchService.search({ context: alice, query: "rankable", limit: 10 });
  const b = await f.searchService.search({ context: alice, query: "rankable", limit: 10 });
  assert.deepEqual(a.items.map((i) => i.resourceId), b.items.map((i) => i.resourceId));
  assert.ok(a.items[0].score >= a.items[a.items.length - 1].score);
});
