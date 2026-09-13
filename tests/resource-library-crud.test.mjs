/** D3-04B · resource-library-crud.test —— Create / Metadata / Query / Inspector / Pagination / Performance。 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createResourceFixture } from "./resource-fixtures.mjs";

const f = await createResourceFixture();
after(() => f.close());
const ctx = f.ctx("alice");

test("create memory/text/code/prompt 真实写入并形成 v1", async () => {
  const mem = await f.resourceService.createResource({ context: ctx, resourceType: "memory", name: "Pref", content: "likes dark mode", memorySubtype: "personal-preference" });
  assert.equal(mem.ok, true);
  assert.equal(mem.resource.version, 1);
  assert.equal(mem.resource.memorySubtype, "personal-preference");
  const text = await f.resourceService.createResource({ context: ctx, resourceType: "text", name: "Note", content: "hello" });
  assert.equal(text.ok, true);
  const code = await f.resourceService.createResource({ context: ctx, resourceType: "code", name: "snippet.js", content: "const a = 1;", language: "javascript" });
  assert.equal(code.ok, true);
  assert.equal(code.resource.language, "javascript");
  const prompt = await f.resourceService.createResource({ context: ctx, resourceType: "prompt", name: "Prompt A", content: "Write a poem" });
  assert.equal(prompt.ok, true);
});

test("category query 按 resourceType 映射（Domain 决定，不由 Renderer 猜）", () => {
  assert.ok(f.resourceService.queryResources({ context: ctx, category: "memory" }).total >= 1);
  assert.ok(f.resourceService.queryResources({ context: ctx, category: "code" }).total >= 1);
  assert.ok(f.resourceService.queryResources({ context: ctx, category: "prompts" }).total >= 1);
  assert.ok(f.resourceService.queryResources({ context: ctx, category: "documents" }).total >= 1);
  assert.equal(f.resourceService.queryResources({ context: ctx, category: "images" }).total, 0);
});

test("updateMetadata：name/description 持久化且不产生内容 version", async () => {
  const r = await f.resourceService.createResource({ context: ctx, resourceType: "text", name: "Meta", content: "x" });
  const up = f.resourceService.updateMetadata({ context: ctx, resourceRef: r.resource.resourceId, name: "Meta Renamed", description: "a description" });
  assert.equal(up.ok, true);
  assert.equal(up.resource.name, "Meta Renamed");
  assert.equal(up.resource.version, 1, "metadata 修改不得 bump content version");
  const got = f.resourceService.get({ context: ctx, resourceRef: r.resource.resourceId });
  assert.equal(got.resource.name, "Meta Renamed");
});

test("Inspector：metadata + capabilities + versions + collection + tags", async () => {
  const col = f.resourceService.createCollection({ context: ctx, name: "Inspector Col" });
  const r = await f.resourceService.createResource({ context: ctx, resourceType: "memory", name: "Inspected", content: "body", memorySubtype: "project-memory", collectionId: col.collection.collectionId, tags: ["alpha"] });
  const insp = f.resourceService.getInspector({ context: ctx, resourceRef: r.resource.resourceId });
  assert.equal(insp.ok, true);
  assert.equal(insp.resource.memorySubtype, "project-memory");
  assert.equal(insp.collection.name, "Inspector Col");
  assert.equal(insp.tags.length, 1);
  assert.equal(insp.versions.length, 1);
  assert.ok(insp.capabilities.effectiveActions.includes("resource.read"));
  assert.equal(insp.capabilities.effective.canRead, true);
});

test("name filter + sort + pagination 在授权结果范围内", async () => {
  for (let i = 0; i < 5; i += 1) {
    await f.resourceService.createResource({ context: ctx, resourceType: "text", name: "Page Item " + i, content: "p" + i });
  }
  const filtered = f.resourceService.queryResources({ context: ctx, category: "documents", filter: { name: "page item" } });
  assert.ok(filtered.total >= 5);
  const page1 = f.resourceService.queryResources({ context: ctx, category: "documents", sort: "name", direction: "asc", limit: 2, offset: 0 });
  const page2 = f.resourceService.queryResources({ context: ctx, category: "documents", sort: "name", direction: "asc", limit: 2, offset: 2 });
  assert.equal(page1.items.length, 2);
  assert.equal(page1.hasMore, true);
  assert.notEqual(page1.items[0].resourceId, page2.items[0].resourceId);
});

test("1,000 Resource metadata：query/filter/sort/pagination 不卡住", () => {
  const now = f.now();
  f.identity.transactSync(() => {
    for (let i = 0; i < 1000; i += 1) {
      const reg = f.resourceStore.insertRegistryResource({ resourceId: "res_perf_" + String(i).padStart(6, "0"), resourceType: i % 2 === 0 ? "text" : "image", ownerUserId: f.users.alice, organizationId: f.orgId, scope: "PERSONAL", name: "Perf " + i, description: "" });
      f.resourceStore.insertLibraryResource({ resourceId: reg.resource_id, resourceType: i % 2 === 0 ? "text" : "image", mimeType: "text/plain", name: "Perf " + i, storageMode: "MANAGED", size: i, source: "user", version: 1, storageDeviceId: "local" });
    }
  });
  const t0 = Date.now();
  const res = f.resourceService.queryResources({ context: ctx, category: "all", sort: "name", direction: "asc", limit: 60, offset: 0 });
  const duration = Date.now() - t0;
  assert.equal(res.ok, true);
  assert.ok(res.total >= 1000);
  assert.equal(res.items.length, 60);
  assert.ok(res.hasMore);
  assert.ok(duration < 5000, "query 1000 metadata 耗时 " + duration + "ms 应可接受");
});
