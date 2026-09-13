/** D3-04B · resource-library-restart.test —— Collection/Memory/Tag/Favorite/Edit 重启持久化。 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { createResourceFixture, reopenResourceRuntime, tempRoot } from "./resource-fixtures.mjs";
import { pw } from "./device-fixtures.mjs";

const root = tempRoot("oa-d3-04b-restart");
const dbPath = path.join(root, "identity.db");
const storeRoot = path.join(root, "library");
const f = await createResourceFixture({ dbPath, storeRoot });
after(() => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  f.close();
});

test("create collection/memory/tag/favorite/edit -> restart 全部持久", async () => {
  const ctx = f.ctx("alice");
  const col = f.resourceService.createCollection({ context: ctx, name: "Persisted Col" });
  const mem = await f.resourceService.createResource({ context: ctx, resourceType: "memory", name: "Persisted Memory", content: "v1", memorySubtype: "decision-memory", collectionId: col.collection.collectionId, tags: ["persist-tag"] });
  const ref = mem.resource.resourceId;
  f.resourceService.setFavorite({ context: ctx, resourceRef: ref, favorite: true });
  const edited = await f.resourceService.replaceText({ context: ctx, resourceRef: ref, text: "v2 persisted", expectedVersion: 1 });
  assert.equal(edited.ok, true);
  f.identity.close();

  const reopened = reopenResourceRuntime({ dbPath, storeRoot });
  const login = await reopened.identity.login({ identifier: "alice@openarc.test", password: pw("alice") });
  const rctx = { sessionRef: login.session.ref, appId: "resource-library" };
  const got = reopened.resourceService.get({ context: rctx, resourceRef: ref });
  assert.equal(got.ok, true);
  assert.equal(got.resource.name, "Persisted Memory");
  assert.equal(got.resource.memorySubtype, "decision-memory");
  assert.equal(got.resource.version, 2);
  assert.equal(got.resource.favorite, true);
  assert.equal(got.resource.collectionId, col.collection.collectionId);
  const read = await reopened.resourceService.readText({ context: rctx, resourceRef: ref });
  assert.equal(read.text, "v2 persisted");
  const tags = reopened.resourceService.listResourceTags({ context: rctx, resourceRef: ref });
  assert.equal(tags.items.some((t) => t.name === "persist-tag"), true);
  const cols = reopened.resourceService.listCollections({ context: rctx });
  assert.ok(cols.items.some((c) => c.name === "Persisted Col" && c.resourceCount === 1));
  reopened.identity.close();
});
