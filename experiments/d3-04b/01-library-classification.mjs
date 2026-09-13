/** D3-04B 探针 01 · CRUD / Classification / Collection / Tag / Favorite / Recent / Trash / Version。 */
import { Probe, createResourceFixture } from "./lib.mjs";
const p = new Probe("01-library-classification", "Resource Library CRUD / Classification / Collection / Tag / Favorite / Recent / Trash / Version");
const f = await createResourceFixture();
const ctx = f.ctx("alice");
try {
  const mem = await f.resourceService.createResource({ context: ctx, resourceType: "memory", name: "Pref", content: "dark", memorySubtype: "personal-preference" });
  const code = await f.resourceService.createResource({ context: ctx, resourceType: "code", name: "a.js", content: "const a=1", language: "javascript" });
  const prompt = await f.resourceService.createResource({ context: ctx, resourceType: "prompt", name: "P", content: "write" });
  p.assert("Create Memory / Code / Prompt -> v1", mem.ok && code.ok && prompt.ok && mem.resource.version === 1, "");
  p.assert("分类映射（Domain 决定）", f.resourceService.queryResources({ context: ctx, category: "memory" }).total === 1 && f.resourceService.queryResources({ context: ctx, category: "code" }).total === 1 && f.resourceService.queryResources({ context: ctx, category: "prompts" }).total === 1, "");

  const col = f.resourceService.createCollection({ context: ctx, name: "Ideas" });
  p.assert("Create Collection", col.ok && col.collection.resourceCount === 0, "");
  f.resourceService.setCollection({ context: ctx, resourceRef: mem.resource.resourceId, collectionId: col.collection.collectionId });
  p.assert("Move Resource -> Collection（count 反映）", f.resourceService.listCollections({ context: ctx }).items.find((c) => c.collectionId === col.collection.collectionId).resourceCount === 1, "");

  await f.resourceService.assignTag({ context: ctx, resourceRef: mem.resource.resourceId, name: "Shoes" });
  await f.resourceService.assignTag({ context: ctx, resourceRef: mem.resource.resourceId, name: "shoes" });
  const tags = f.resourceService.listResourceTags({ context: ctx, resourceRef: mem.resource.resourceId });
  p.assert("Tag 规范化（Shoes == shoes）", tags.items.length === 1, "count=" + tags.items.length);

  f.resourceService.setFavorite({ context: ctx, resourceRef: mem.resource.resourceId, favorite: true });
  p.assert("Favorite per-user", f.resourceService.listFavorites({ context: ctx }).count === 1 && f.resourceService.listFavorites({ context: f.ctx("dana") }).count === 0, "");
  p.assert("Favorite 不 bump version", f.resourceService.get({ context: ctx, resourceRef: mem.resource.resourceId }).resource.version === 1, "");

  f.resourceService.touchRecent({ context: ctx, resourceRef: mem.resource.resourceId });
  p.assert("Recent 只在真实打开时更新", f.resourceService.listRecent({ context: ctx }).count === 1, "");

  const e1 = await f.resourceService.replaceText({ context: ctx, resourceRef: mem.resource.resourceId, text: "dark v2", expectedVersion: 1 });
  const conflict = await f.resourceService.replaceText({ context: ctx, resourceRef: mem.resource.resourceId, text: "stale", expectedVersion: 1 });
  p.assert("Version-aware save + 冲突拒绝", e1.ok && e1.resource.version === 2 && !conflict.ok && conflict.error === "VERSION_CONFLICT", "");
  const restored = f.resourceService.restoreVersion({ context: ctx, resourceRef: mem.resource.resourceId, version: 1 });
  p.assert("Restore Version -> v3（不倒退）", restored.ok && restored.resource.version === 3, "");
  p.assert("Metadata 修改不 bump version", f.resourceService.updateMetadata({ context: ctx, resourceRef: mem.resource.resourceId, name: "Renamed" }).resource.version === 3, "");

  const delCol = f.resourceService.deleteCollection({ context: ctx, collectionId: col.collection.collectionId });
  p.assert("删除 Collection 不删除 Resource（转 Unfiled）", delCol.ok && delCol.movedToUnfiled === 1 && f.resourceService.get({ context: ctx, resourceRef: mem.resource.resourceId }).ok, "");
  f.resourceService.delete({ context: ctx, resourceRef: mem.resource.resourceId });
  p.assert("Delete -> Trash；normal list 不含", !f.resourceService.list({ context: ctx }).items.some((i) => i.resourceId === mem.resource.resourceId), "");
  f.resourceService.restore({ context: ctx, resourceRef: mem.resource.resourceId });
  p.assert("Restore 同一 ResourceRef", f.resourceService.get({ context: ctx, resourceRef: mem.resource.resourceId }).resource.trashed === false, "");

  const insp = f.resourceService.getInspector({ context: ctx, resourceRef: mem.resource.resourceId });
  p.assert("Inspector 汇总 capabilities / versions / provenance", insp.ok && insp.versions.length === 3 && insp.capabilities.effective.canRead === true && insp.provenance.memorySubtype === "personal-preference", "");
} finally {
  f.close();
}
p.finish();
if (p.verdict() === "FAIL") process.exitCode = 1;
