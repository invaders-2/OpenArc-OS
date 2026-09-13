/** D3-04C · resource-preview-cache.test —— cache key / invalidation / cleanup。 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { createResourceFixture } from "./resource-fixtures.mjs";

const require = createRequire(import.meta.url);
const searchDomain = require("../electron/search-domain.cjs");

const f = await createResourceFixture();
after(() => f.close());
const alice = f.ctx("alice");

test("cache key 至少含 resourceId / version / checksum / kind / previewVersion", () => {
  const base = { resourceId: "res_1", resourceVersion: 1, checksum: "abc", kind: "thumbnail", previewVersion: 1 };
  const a = searchDomain.previewCacheKey(base);
  assert.equal(a, searchDomain.previewCacheKey({ ...base }));
  assert.notEqual(a, searchDomain.previewCacheKey({ ...base, resourceVersion: 2 }));
  assert.notEqual(a, searchDomain.previewCacheKey({ ...base, checksum: "def" }));
  assert.notEqual(a, searchDomain.previewCacheKey({ ...base, kind: "poster" }));
  assert.notEqual(a, searchDomain.previewCacheKey({ ...base, previewVersion: 2 }));
});

test("内容变化后旧 cache key 不再命中（派生数据可失效）", async () => {
  const r = await f.resourceService.createResource({ context: alice, resourceType: "text", name: "CacheKey", content: "v1" });
  const k1 = searchDomain.previewCacheKey({ resourceId: r.resource.resourceId, resourceVersion: 1, checksum: r.resource.checksum, kind: "text" });
  await f.resourceService.replaceText({ context: alice, resourceRef: r.resource.resourceId, text: "v2", expectedVersion: 1 });
  const after = f.resourceService.get({ context: alice, resourceRef: r.resource.resourceId }).resource;
  const k2 = searchDomain.previewCacheKey({ resourceId: r.resource.resourceId, resourceVersion: after.version, checksum: after.checksum, kind: "text" });
  assert.notEqual(k1, k2);
});

test("thumbnail 在无 nativeImage 的 Node 环境明确 UNSUPPORTED（不伪造）", async () => {
  const png = f.writeSource("thumb.png", Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]));
  const imp = await f.resourceService.importManaged({ context: alice, sourcePath: png, name: "thumb.png" });
  const th = await f.previewService.thumbnail({ context: alice, resourceRef: imp.resource.resourceId });
  assert.equal(th.ok, false);
  assert.equal(th.error, "PREVIEW_UNSUPPORTED");
});

test("cleanupForResource：派生 cache 行与文件被清理，Resource 不受影响", async () => {
  const r = await f.resourceService.createResource({ context: alice, resourceType: "text", name: "Cleanup", content: "x" });
  const dir = path.join(f.storeRoot, "thumbnails");
  fs.mkdirSync(dir, { recursive: true });
  const storageKey = path.join(dir, "fake.png");
  fs.writeFileSync(storageKey, "png");
  f.searchStore.upsertPreview({ cacheKey: "pv_fake", resourceId: r.resource.resourceId, resourceVersion: 1, contentChecksum: r.resource.checksum, previewKind: "thumbnail", storageKey, size: 3, mimeType: "image/png", status: "READY" });
  assert.ok(f.searchStore.previewByResource(r.resource.resourceId).length >= 1);
  f.previewService.cleanupForResource(r.resource.resourceId);
  assert.equal(f.searchStore.previewByResource(r.resource.resourceId).length, 0);
  assert.equal(fs.existsSync(storageKey), false);
  assert.equal(f.resourceService.get({ context: alice, resourceRef: r.resource.resourceId }).ok, true);
});
