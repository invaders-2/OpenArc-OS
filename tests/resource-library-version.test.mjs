/** D3-04B · resource-library-version.test —— Version-aware editing / conflict / restore。 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createResourceFixture } from "./resource-fixtures.mjs";

const f = await createResourceFixture();
after(() => f.close());
const ctx = f.ctx("alice");

test("version-aware save：v1 -> v2；stale expectedVersion -> VERSION_CONFLICT 不覆盖", async () => {
  const r = await f.resourceService.createResource({ context: ctx, resourceType: "text", name: "Editor", content: "A" });
  const ref = r.resource.resourceId;
  const first = await f.resourceService.replaceText({ context: ctx, resourceRef: ref, text: "B", expectedVersion: 1 });
  assert.equal(first.ok, true);
  assert.equal(first.resource.version, 2);
  const stale = await f.resourceService.replaceText({ context: ctx, resourceRef: ref, text: "C", expectedVersion: 1 });
  assert.equal(stale.ok, false);
  assert.equal(stale.error, "VERSION_CONFLICT");
  assert.equal((await f.resourceService.readText({ context: ctx, resourceRef: ref })).text, "B");
});

test("restoreVersion：v1 -> v3（不倒退），内容回到 v1", async () => {
  const r = await f.resourceService.createResource({ context: ctx, resourceType: "text", name: "Restore", content: "first" });
  const ref = r.resource.resourceId;
  await f.resourceService.replaceText({ context: ctx, resourceRef: ref, text: "second", expectedVersion: 1 });
  const restored = f.resourceService.restoreVersion({ context: ctx, resourceRef: ref, version: 1 });
  assert.equal(restored.ok, true);
  assert.equal(restored.resource.version, 3);
  assert.equal((await f.resourceService.readText({ context: ctx, resourceRef: ref })).text, "first");
  const versions = f.resourceService.listVersions({ context: ctx, resourceRef: ref });
  assert.deepEqual(versions.items.map((v) => v.version), [1, 2, 3]);
});

test("编辑历史版本不删旧版本；listVersions 反映全部版本", async () => {
  const r = await f.resourceService.createResource({ context: ctx, resourceType: "code", name: "Code", content: "v1", language: "javascript" });
  await f.resourceService.replaceText({ context: ctx, resourceRef: r.resource.resourceId, text: "v2", expectedVersion: 1 });
  await f.resourceService.replaceText({ context: ctx, resourceRef: r.resource.resourceId, text: "v3", expectedVersion: 2 });
  const versions = f.resourceService.listVersions({ context: ctx, resourceRef: r.resource.resourceId });
  assert.equal(versions.count, 3);
  assert.equal(versions.currentVersion, 3);
});
